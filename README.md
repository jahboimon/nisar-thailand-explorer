# NISAR Data Availability Explorer — Thailand

A static, GitHub Pages-ready explorer for **verified ASF Search metadata** intersecting Thailand. The browser never calls ASF: a scheduled Python pipeline downloads metadata, normalizes and deduplicates granules, and commits static GeoJSON/JSON consumed by Leaflet and Turf.js.

## What it shows

- Real GCOV, GSLC, and RSLC footprints returned by ASF (an unavailable product remains an empty filter, never a claimed coverage layer)
- Province or user-drawn AOI spatial filtering
- Acquisition date, product level, orbit direction, and data maturity filtering
- Distinct granule count, unique acquisition dates, first/last date
- All-track date gaps and same-acquisition-geometry gaps (computed independently)
- Clickable scene metadata and source links when supplied by ASF
- Data freshness and pipeline diagnostics

## Local setup

```powershell
py -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r requirements.txt
python scripts/update_data.py
python -m http.server 8000 --directory site
```

Open `http://localhost:8000`. The checked-in empty snapshot is valid, so the UI also works before the first successful fetch.

## Tests

```powershell
pip install -r requirements-dev.txt
pytest
```

JavaScript logic is tested without a browser:

```powershell
node --test tests/js/*.test.mjs
```

## GitHub Pages deployment

1. Create a GitHub repository and push this project to its default branch.
2. In **Settings → Pages**, select **GitHub Actions** as the source.
3. Run **Actions → Update NISAR metadata and deploy Pages → Run workflow** once.
4. The workflow fetches data, runs Python and JavaScript tests, uploads `site/`, deploys Pages, and commits refreshed data files back only when they changed.

The workflow also runs daily at 02:17 UTC (09:17 Thailand time). It needs only the standard repository `GITHUB_TOKEN`; there are no ASF or Earthdata credentials in the frontend or repository. Metadata search is public. Product downloads may require Earthdata authentication and are intentionally not implemented here.

## Pipeline design

`scripts/update_data.py` queries ASF's GeoJSON endpoint separately for the VALIDATED, PROVISIONAL, and BETA GCOV/GSLC/RSLC short names and bounded UTC time windows. Results are split recursively when a configured result ceiling is reached, retried with exponential backoff, normalized defensively, and deduplicated by a stable granule identifier preference (`fileID`, `granuleName`, `sceneName`, then a deterministic metadata hash). Exact repeated API rows are removed; distinct processing versions remain separate granules. An incomplete refresh never replaces the previous published scene snapshot.

Thailand province boundaries are refreshed from geoBoundaries ADM1 data and cached in `site/data/thailand-provinces.geojson`. ASF candidates are retrieved with a bounding box, then filtered against the union of the 77 province geometries. A footprint is retained in full when any part intersects Thailand. Candidate and exclusion counts are recorded in `site/data/status.json`.

Configuration is in `config/pipeline.json`. ASF currently recommends `shortName` for NISAR discovery because some NISAR attributes are not directly searchable. The pipeline records the exact query families and per-product counts in its status output so availability claims remain auditable.

## Important verification notes

- A successful metadata search establishes catalog availability, not download authorization or product quality.
- Data maturity comes from the verified collection family (`BETA`, `PROVISIONAL`, or `VALIDATED`). It is separate from `productionConfiguration` such as `PR`.
- Orbit direction, relative track/path, frame, collection, production configuration, and acquisition time are preserved. Unknown values remain `UNKNOWN`.
- The **all-track gap** is the largest interval between consecutive distinct UTC acquisition dates in the filtered result.
- The **same-geometry gap** groups observations only when orbit direction, relative track, and frame are all known and equal. It does not prove pixel-identical coverage; users should inspect footprints for analysis-grade stacking.
- Metadata links open the ASF GeoJSON record query. Download links are labelled as product HDF5 downloads and appear only when ASF supplies an HTTPS URL.
- API schema drift is surfaced as warnings/errors in `status.json`; empty successful results are distinguished from failed requests.

## Structure

```text
site/                 Static GitHub Pages application
scripts/              ASF/province update pipeline
tests/                Python and Node tests
config/pipeline.json  Product/query configuration
.github/workflows/    Daily update and Pages deployment
```

## Sources

- [ASF Search API keywords](https://docs.asf.alaska.edu/api/keywords/)
- [ASF NISAR search guidance](https://docs.asf.alaska.edu/asf_search/BestPractices/)
- [geoBoundaries](https://www.geoboundaries.org/)

