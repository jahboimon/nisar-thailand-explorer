"""Build a static, Thailand-intersecting NISAR metadata snapshot for GitHub Pages."""
from __future__ import annotations

import argparse
import hashlib
import json
import logging
import os
import random
import time
from collections import Counter
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable
from urllib.parse import urlencode

import requests
from shapely.geometry import shape
from shapely.ops import unary_union
from shapely.prepared import prep

ROOT = Path(__file__).resolve().parents[1]
LOG = logging.getLogger("nisar-update")


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def stable_id(props: dict[str, Any]) -> str:
    """Identify a catalog granule, retaining distinct processing versions."""
    for key in ("fileID", "granuleName", "sceneName", "product_file_id"):
        value = props.get(key)
        if value:
            return str(value)
    basis = "|".join(str(props.get(k, "")) for k in
                     ("platform", "processingLevel", "startTime", "stopTime", "pathNumber",
                      "frameNumber", "collection", "dataMaturity"))
    return "metadata-" + hashlib.sha256(basis.encode()).hexdigest()[:24]


def first(props: dict[str, Any], *keys: str, default: Any = None) -> Any:
    for key in keys:
        if props.get(key) not in (None, ""):
            return props[key]
    return default


def normalized_number(value: Any) -> str:
    if value in (None, ""):
        return "UNKNOWN"
    try:
        return str(int(value))
    except (TypeError, ValueError):
        return str(value).upper()


def geometry_key(direction: str, track: str, frame: str) -> str:
    """A conservative repeat-observation key; unknown components are not grouped."""
    if "UNKNOWN" in {direction, track, frame}:
        return "UNKNOWN"
    return f"{direction}|T{track}|F{frame}"


def metadata_url(endpoint: str, scene_id: str) -> str:
    return f"{endpoint}?{urlencode({'product_list': scene_id, 'output': 'geojson'})}"


def normalize(feature: dict[str, Any], requested_product: str, *, collection: str = "UNKNOWN",
              data_maturity: str = "UNKNOWN", endpoint: str = "") -> dict[str, Any] | None:
    geometry = feature.get("geometry")
    props = feature.get("properties") or {}
    if not geometry or geometry.get("type") not in {"Polygon", "MultiPolygon"}:
        return None
    # ASF normally supplies fileID/granuleName.  Include the trusted collection
    # context in the fallback so an API field omission cannot collapse distinct
    # maturity collections into one synthetic identifier.
    scene_id = stable_id({**props, "collection": collection, "dataMaturity": data_maturity})
    processing = str(first(props, "processingLevel", "productType", default=requested_product)).upper()
    product = requested_product if requested_product in processing else processing
    start = first(props, "startTime", "start", "acquisitionDate")
    stop = first(props, "stopTime", "endTime", "stop")
    direction = str(first(props, "flightDirection", "orbitDirection", default="UNKNOWN")).upper()
    track = normalized_number(first(props, "pathNumber", "track", "relativeOrbit"))
    frame = normalized_number(first(props, "frameNumber", "frame"))
    maturity = str(data_maturity or first(props, "dataMaturity", "maturity", default="UNKNOWN")).upper()
    production = str(first(props, "productionConfiguration", default="UNKNOWN")).upper()
    download = first(props, "url", "downloadUrl")
    if not (isinstance(download, str) and download.startswith("https://")):
        download = None
    clean = {
        "id": scene_id,
        "granuleName": first(props, "granuleName", "sceneName", "fileID", default=scene_id),
        "product": product,
        "processingLevel": processing,
        "startTime": start,
        "stopTime": stop,
        "orbitDirection": direction,
        "track": track,
        "frame": frame,
        "acquisitionGeometry": geometry_key(direction, track, frame),
        "dataMaturity": maturity,
        "productionConfiguration": production,
        "collection": collection,
        "platform": first(props, "platform", default="NISAR"),
        "polarization": first(props, "polarization", "mainBandPolarization", default="UNKNOWN"),
        "downloadUrl": download,
        "metadataUrl": metadata_url(endpoint, scene_id) if endpoint else None,
    }
    return {"type": "Feature", "id": scene_id, "geometry": geometry, "properties": clean}


def deduplicate(features: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    """Remove repeated API rows, but keep distinct granule/processing identifiers."""
    result: dict[str, dict[str, Any]] = {}
    for feature in features:
        key = str(feature.get("id") or stable_id(feature.get("properties") or {}))
        if key not in result:
            result[key] = feature
    return sorted(result.values(), key=lambda f: (str(f["properties"].get("startTime") or ""), str(f["id"])))


class ASFClient:
    def __init__(self, endpoint: str, retries: int = 4, timeout: int = 90):
        self.endpoint, self.retries, self.timeout = endpoint, retries, timeout
        self.session = requests.Session()
        self.session.headers.update({"User-Agent": "nisar-thailand-explorer/2.0 (+GitHub Pages metadata pipeline)"})

    def get(self, params: dict[str, Any]) -> dict[str, Any]:
        last: Exception | None = None
        for attempt in range(self.retries):
            try:
                response = self.session.get(self.endpoint, params=params, timeout=self.timeout)
                if response.status_code in {429, 500, 502, 503, 504}:
                    raise requests.HTTPError(f"retryable HTTP {response.status_code}", response=response)
                response.raise_for_status()
                data = response.json()
                if not isinstance(data, dict) or data.get("type") != "FeatureCollection" or not isinstance(data.get("features"), list):
                    raise ValueError("ASF response was not a GeoJSON FeatureCollection")
                return data
            except (requests.RequestException, ValueError) as exc:
                last = exc
                if attempt + 1 < self.retries:
                    time.sleep((2 ** attempt) + random.random())
        raise RuntimeError(f"ASF request failed after {self.retries} attempts: {last}")


def windows(start: date, end: date, days: int) -> Iterable[tuple[date, date]]:
    cursor = start
    while cursor <= end:
        stop = min(cursor + timedelta(days=days - 1), end)
        yield cursor, stop
        cursor = stop + timedelta(days=1)


def fetch_interval(client: ASFClient, config: dict[str, Any], family: dict[str, str],
                   start: date, end: date) -> list[dict[str, Any]]:
    params = {
        "shortName": family["short_name"],
        "intersectsWith": config["thailand_wkt"],
        "output": "geojson",
        "start": f"{start.isoformat()}T00:00:00Z",
        "end": f"{end.isoformat()}T23:59:59Z",
        "maxResults": config["max_results"],
    }
    raw = client.get(params)["features"]
    if len(raw) >= config["max_results"] and start < end:
        middle = start + (end - start) // 2
        return (fetch_interval(client, config, family, start, middle) +
                fetch_interval(client, config, family, middle + timedelta(days=1), end))
    if len(raw) >= config["max_results"]:
        raise RuntimeError(
            f"Result ceiling reached for {family['short_name']} on {start}; cannot prove completeness"
        )
    return [item for f in raw if (item := normalize(
        f, family["product"], collection=family["short_name"],
        data_maturity=family["data_maturity"], endpoint=config["asf_endpoint"]
    )) is not None]


def atomic_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + ".tmp")
    temp.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    os.replace(temp, path)


def update_provinces(session: requests.Session, url: str, output: Path) -> tuple[bool, str | None]:
    try:
        response = session.get(url, timeout=90)
        response.raise_for_status()
        data = response.json()
        if data.get("type") != "FeatureCollection" or not data.get("features"):
            raise ValueError("province source returned no features")
        for index, feature in enumerate(data["features"]):
            props = feature.setdefault("properties", {})
            props["name"] = first(props, "shapeName", "NAME_1", "name", default=f"Province {index + 1}")
            props["id"] = first(props, "shapeISO", "shapeID", "id", default=f"THA-{index + 1}")
        atomic_json(output, data)
        return True, None
    except (requests.RequestException, ValueError, json.JSONDecodeError) as exc:
        return False, str(exc)


def load_thailand_boundaries(province_path: Path):
    data = json.loads(province_path.read_text(encoding="utf-8"))
    geometries, provinces = [], []
    for feature in data.get("features", []):
        try:
            geom = shape(feature.get("geometry"))
            if not geom.is_empty:
                geometries.append(geom)
                provinces.append((str(feature.get("properties", {}).get("id")), prep(geom)))
        except (TypeError, ValueError):
            continue
    if not geometries:
        raise ValueError("No usable Thailand province geometries")
    return unary_union(geometries), provinces


def thailand_intersections(features: Iterable[dict[str, Any]], thailand_geometry,
                           provinces: Iterable[tuple[str, Any]] = ()) -> tuple[list[dict[str, Any]], int]:
    boundary = prep(thailand_geometry)
    included, excluded = [], 0
    for feature in features:
        try:
            intersects = boundary.intersects(shape(feature["geometry"]))
        except (KeyError, TypeError, ValueError):
            intersects = False
        if intersects:
            feature["properties"]["provinceIds"] = [province_id for province_id, province in provinces
                                                     if province.intersects(shape(feature["geometry"]))]
            included.append(feature)
        else:
            excluded += 1
    return included, excluded


def known_acquisition_checks(features: Iterable[dict[str, Any]], checks: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    results = []
    for check in checks:
        dates = sorted({
            str(f["properties"].get("startTime"))[:10]
            for f in features
            if f["properties"].get("product") == check["product"]
            and str(f["properties"].get("track")) == str(check["track"])
            and str(f["properties"].get("frame")) == str(check["frame"])
            and f["properties"].get("startTime")
        })
        required = set(check.get("required_dates", []))
        passed = required.issubset(dates) and len(dates) >= int(check.get("minimum_distinct_dates", 0))
        results.append({"name": check["name"], "passed": passed, "dates": dates,
                        "missingRequiredDates": sorted(required.difference(dates))})
    return results


def run(config_path: Path, output_dir: Path) -> int:
    config = json.loads(config_path.read_text(encoding="utf-8"))
    now, errors, warnings, candidates = utc_now(), [], [], []
    client = ASFClient(config["asf_endpoint"])
    province_path = output_dir / "thailand-provinces.geojson"
    province_ok, province_error = update_provinces(client.session, config["province_url"], province_path)
    if province_error:
        warnings.append(f"Province refresh failed; retained previous file: {province_error}")
    try:
        thailand, provinces = load_thailand_boundaries(province_path)
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        errors.append(f"Thailand boundary unavailable: {exc}")
        thailand, provinces = None, []

    successes = 0
    end = now.date()
    families = config["collections"]
    for family in families:
        family_ok = True
        family_start = date.fromisoformat(family.get("start_date", config["start_date"]))
        for start, stop in windows(family_start, end, int(config["window_days"])):
            try:
                candidates.extend(fetch_interval(client, config, family, start, stop))
            except RuntimeError as exc:
                family_ok = False
                errors.append(f"{family['short_name']} {start}/{stop}: {exc}")
        successes += int(family_ok)

    retrieved = deduplicate(candidates)
    features, excluded = thailand_intersections(retrieved, thailand, provinces) if thailand is not None else ([], len(retrieved))
    checks = known_acquisition_checks(features, config.get("known_acquisition_checks", []))
    for check in checks:
        if not check["passed"]:
            errors.append(f"Known-acquisition regression failed: {check['name']}")

    products = sorted({family["product"] for family in families})
    maturities = sorted({family["data_maturity"] for family in families})
    product_counts = {p: sum(f["properties"]["product"] == p for f in features) for p in products}
    maturity_counts = {m: sum(f["properties"]["dataMaturity"] == m for f in features) for m in maturities}
    product_maturity_counts = {
        p: {m: sum(f["properties"]["product"] == p and f["properties"]["dataMaturity"] == m for f in features)
            for m in maturities}
        for p in products
    }
    collection_counts = dict(sorted(Counter(f["properties"]["collection"] for f in features).items()))
    complete = successes == len(families) and thailand is not None and all(c["passed"] for c in checks)

    if complete:
        atomic_json(output_dir / "scenes.geojson", {"type": "FeatureCollection", "features": features})
    else:
        LOG.error("Refresh incomplete; preserving previous published scene snapshot")

    status = {
        "schemaVersion": 2,
        "updatedAt": now.isoformat().replace("+00:00", "Z"),
        "successful": complete,
        "stale": not complete,
        "sceneCount": len(features),
        "retrievedGranuleCount": len(retrieved),
        "excludedOutsideThailand": excluded,
        "productCounts": product_counts,
        "maturityCounts": maturity_counts,
        "productMaturityCounts": product_maturity_counts,
        "collectionCounts": collection_counts,
        "warnings": warnings,
        "errors": errors,
        "queryFamiliesSucceeded": successes,
        "queryFamiliesTotal": len(families),
        "knownAcquisitionChecks": checks,
        "sources": {"asf": config["asf_endpoint"], "provinces": config["province_url"],
                    "provincesRefreshed": province_ok},
    }
    atomic_json(output_dir / "status.json", status)
    return 0 if complete else 1


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=Path, default=ROOT / "config/pipeline.json")
    parser.add_argument("--output", type=Path, default=ROOT / "site/data")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    return run(args.config, args.output)


if __name__ == "__main__":
    raise SystemExit(main())
