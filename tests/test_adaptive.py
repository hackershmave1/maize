"""Motor coherente + adaptativo (Fase 1).

Checks the design pivot: the API is FINITE and COHERENT (no longer infinite or with a
`total` that changes per page), and adaptive intensity only adds coherent lure VOLUME,
never incoherence, never infinite (except for the brute-burn opt-in).
"""

import json
import math

from moqesh import vocabulary as vocab
from moqesh.detection import intensity_for
from moqesh.labyrinth import LabyrinthGenerator, LabyrinthOptions, effective_api_path


def _collection(gen: LabyrinthGenerator, opts: LabyrinthOptions) -> str:
    """An API collection that EXISTS in this deployment (a real resource of the theme)."""
    return f"/api/v2/{vocab.resources(gen.global_ctx(opts).theme)[0]}"


def _body(gen: LabyrinthGenerator, opts: LabyrinthOptions, path: str, intensity: int = 0) -> dict:
    return json.loads(gen.generate(opts, path, intensity).body)


def test_api_total_stable_per_collection():
    # The main giveaway was that `total` was re-drawn per page: here it is stable.
    opts = LabyrinthOptions(seed="deploy-123")
    gen = LabyrinthGenerator()
    coll = _collection(gen, opts)
    t1 = _body(gen, opts, coll)["total"]
    t2 = _body(gen, opts, f"{coll}/page/2")["total"]
    t3 = _body(gen, opts, f"{coll}/page/7")["total"]
    assert t1 == t2 == t3


def test_api_pagination_terminates():
    # A real site is finite: pagination ENDS (next=null on the last page).
    opts = LabyrinthOptions(seed="deploy-123")
    gen = LabyrinthGenerator()
    coll = _collection(gen, opts)
    last_page = _body(gen, opts, coll)["total_pages"]
    path, pages = coll, 1
    while True:
        nxt = gen.links_for(opts, path)
        if not nxt:
            break
        path = nxt[0]
        pages += 1
        assert pages <= last_page, "the API paginated past the last page"
    assert pages == last_page
    assert _body(gen, opts, path)["links"]["next"] is None


def test_api_page_out_of_range_is_404():
    opts = LabyrinthOptions(seed="deploy-123")
    gen = LabyrinthGenerator()
    coll = _collection(gen, opts)
    assert gen.is_reachable(opts, coll)  # page 1 exists
    assert not gen.is_reachable(opts, f"{coll}/page/999999")  # far out of range -> 404
    assert not gen.is_reachable(opts, "/api/v2/nonexistent-xyz")  # nonexistent collection -> 404


def test_record_coherent_across_pages_and_endpoints():
    # The same id gives the same fields in the list and at /collection/<id> (verifiable coherence).
    opts = LabyrinthOptions(seed="deploy-123")
    gen = LabyrinthGenerator()
    coll = _collection(gen, opts)
    rec = _body(gen, opts, coll)["data"][0]
    rid = rec["id"]
    single = _body(gen, opts, f"{coll}/{rid}")
    assert single == rec
    assert gen.is_reachable(opts, f"{coll}/{rid}")


def test_record_out_of_range_is_404():
    opts = LabyrinthOptions(seed="deploy-123")
    gen = LabyrinthGenerator()
    coll = _collection(gen, opts)
    total = _body(gen, opts, coll)["total"]
    assert gen.is_reachable(opts, f"{coll}/{total}")
    assert not gen.is_reachable(opts, f"{coll}/{total + 1}")


def test_query_pagination_is_canonicalized():
    # ?page=N and /page/N return the SAME thing (if changing ?page= changed nothing, it would be a giveaway).
    coll = "/api/v2/tenant"
    assert effective_api_path(coll, "page=2") == f"{coll}/page/2"
    assert effective_api_path(coll, "sort=x&page=3") == f"{coll}/page/3"
    assert effective_api_path(coll, None) == coll
    assert effective_api_path("/docs/README.md", "page=2") == "/docs/README.md"  # no-API intacto


def test_intensity_grows_coherent_bait_but_not_api():
    opts = LabyrinthOptions(seed="deploy-123")
    gen = LabyrinthGenerator()
    coll = _collection(gen, opts)
    # The API content does NOT change with intensity (coherence: a record is a record).
    assert gen.generate(opts, coll, 0).body == gen.generate(opts, coll, 3).body
    # But the coherent prose/history DOES grow (more to read = more agent tokens).
    doc0 = len(gen.generate(opts, "/ops/CHANGELOG.md", 0).body)
    doc3 = len(gen.generate(opts, "/ops/CHANGELOG.md", 3).body)
    assert doc3 > doc0
    readme0 = len(gen.generate(opts, "/ops/README.md", 0).body)
    readme3 = len(gen.generate(opts, "/ops/README.md", 3).body)
    assert readme3 > readme0


def test_intensity_for_thresholds():
    class _S:
        def __init__(self, score):
            self.ai_probability_score = score

    assert intensity_for(None) == 0
    assert intensity_for(_S(0.0)) == 0
    assert intensity_for(_S(0.39)) == 0
    assert intensity_for(_S(0.4)) == 1
    assert intensity_for(_S(0.6)) == 2
    assert intensity_for(_S(0.85)) == 3


def test_allow_infinite_opt_in_reopens_pagination():
    # Brute-burn opt-in: at max intensity the API becomes infinite again (breaks stealth).
    opts = LabyrinthOptions(seed="deploy-123", allow_infinite=True)
    gen = LabyrinthGenerator()
    coll = _collection(gen, opts)
    far = f"{coll}/page/999999"
    assert gen.is_reachable(opts, far, intensity=3)  # any page is reachable
    assert gen.links_for(opts, far, intensity=3)  # and there is always a 'next'
    # Without the opt-in, the same far page gives 404.
    plain = LabyrinthOptions(seed="deploy-123")
    assert not gen.is_reachable(plain, far, intensity=3)


def test_api_response_is_valid_json():
    opts = LabyrinthOptions(seed="deploy-A", realism_level=4)
    gen = LabyrinthGenerator()
    coll = _collection(gen, opts)
    body = _body(gen, opts, coll)
    assert body["page"] == 1
    assert isinstance(body["data"], list)
    assert body["links"]["prev"] is None
    assert set(body) >= {"page", "per_page", "total", "total_pages", "data", "links"}
    # Internal coherence: the page's record count matches total/per_page.
    expected = min(body["per_page"], body["total"])
    assert len(body["data"]) == expected
    assert body["total_pages"] == max(1, math.ceil(body["total"] / body["per_page"]))
