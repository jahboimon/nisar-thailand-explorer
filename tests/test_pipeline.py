from datetime import date

from shapely.geometry import box

from scripts.update_data import (
    deduplicate,
    geometry_key,
    known_acquisition_checks,
    normalize,
    stable_id,
    thailand_intersections,
    windows,
)


def feature(scene="A", product="GCOV", geometry=None):
    return {
        "type": "Feature",
        "id": scene,
        "geometry": geometry or {"type": "Polygon", "coordinates": [[[100, 10], [101, 10], [101, 11], [100, 11], [100, 10]]]},
        "properties": {"id": scene, "product": product, "startTime": "2026-01-01T00:00:00Z"},
    }


def test_stable_id_prefers_file_id():
    assert stable_id({"fileID": "file", "granuleName": "granule"}) == "file"


def test_stable_id_fallback_is_deterministic():
    props = {"platform": "NISAR", "processingLevel": "GCOV", "startTime": "2026-01-01"}
    assert stable_id(props) == stable_id(dict(props))


def test_deduplicate_removes_api_repeats_but_keeps_processing_versions():
    provisional = feature("NISAR_L2_PR_GCOV_P05023_001")
    validated = feature("NISAR_L2_PR_GCOV_P05036_001")
    got = deduplicate([provisional, provisional, validated])
    assert [item["id"] for item in got] == ["NISAR_L2_PR_GCOV_P05023_001", "NISAR_L2_PR_GCOV_P05036_001"]


def test_normalize_rejects_missing_geometry():
    assert normalize({"properties": {"fileID": "x"}}, "GCOV") is None


def test_normalize_separates_maturity_and_production_and_preserves_geometry_fields():
    raw = {
        "geometry": feature()["geometry"],
        "properties": {
            "fileID": "x",
            "startTime": "2026-06-21T00:00:00Z",
            "flightDirection": "ASCENDING",
            "pathNumber": 112,
            "frameNumber": 9,
            "productionConfiguration": "PR",
        },
    }
    got = normalize(raw, "GCOV", collection="NISAR_L2_GCOV_PROVISIONAL_V1", data_maturity="PROVISIONAL", endpoint="https://example.test/search")["properties"]
    assert got["dataMaturity"] == "PROVISIONAL"
    assert got["productionConfiguration"] == "PR"
    assert got["track"] == "112" and got["frame"] == "9"
    assert got["acquisitionGeometry"] == "ASCENDING|T112|F9"
    assert got["collection"] == "NISAR_L2_GCOV_PROVISIONAL_V1"
    assert got["metadataUrl"].startswith("https://example.test/search?")


def test_normalize_preserves_unknown_metadata_without_false_geometry_group():
    raw = {"geometry": feature()["geometry"], "properties": {"fileID": "x", "startTime": "2026-01-01T00:00:00Z"}}
    got = normalize(raw, "GCOV")["properties"]
    assert got["orbitDirection"] == "UNKNOWN"
    assert got["track"] == "UNKNOWN" and got["frame"] == "UNKNOWN"
    assert got["acquisitionGeometry"] == "UNKNOWN"


def test_geometry_key_requires_direction_track_and_frame():
    assert geometry_key("ASCENDING", "112", "9") == "ASCENDING|T112|F9"
    assert geometry_key("ASCENDING", "112", "UNKNOWN") == "UNKNOWN"


def test_thailand_intersection_keeps_full_intersecting_footprint_and_excludes_outside():
    crossing = feature("crossing", geometry={"type": "Polygon", "coordinates": [[[99, 9], [101, 9], [101, 11], [99, 11], [99, 9]]]})
    outside = feature("outside", geometry={"type": "Polygon", "coordinates": [[[110, 20], [111, 20], [111, 21], [110, 21], [110, 20]]]})
    included, excluded = thailand_intersections([crossing, outside], box(100, 10, 102, 12), [("THA-TEST", box(100, 10, 102, 12))])
    assert [item["id"] for item in included] == ["crossing"]
    assert included[0]["geometry"] == crossing["geometry"]
    assert included[0]["properties"]["provinceIds"] == ["THA-TEST"]
    assert excluded == 1


def test_known_orbit_112_frame_9_regression_check():
    items = []
    for index, acquisition_date in enumerate(["2026-06-21", "2026-07-03", "2026-07-15", "2026-08-20", "2026-09-01", "2026-09-13", "2026-09-25", "2026-10-07", "2026-10-19", "2026-10-31"]):
        item = feature(str(index))
        item["properties"].update({"track": "112", "frame": "9", "startTime": f"{acquisition_date}T00:00:00Z"})
        items.append(item)
    check = {"name": "known", "product": "GCOV", "track": "112", "frame": "9", "required_dates": ["2026-06-21", "2026-10-31"], "minimum_distinct_dates": 10}
    result = known_acquisition_checks(items, [check])[0]
    assert result["passed"] is True
    assert len(result["dates"]) == 10


def test_windows_cover_range_without_overlap():
    assert list(windows(date(2026, 1, 1), date(2026, 1, 5), 2)) == [
        (date(2026, 1, 1), date(2026, 1, 2)),
        (date(2026, 1, 3), date(2026, 1, 4)),
        (date(2026, 1, 5), date(2026, 1, 5)),
    ]
