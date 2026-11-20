"""The unified typed call: a KIND, a request spec, a result spec -- one endpoint, many vendors.

The hub is doubled at the two functions every hub call goes through (``HubProxy.try_call`` for the
listing and the chain, ``HubProxy.send`` for ``invoke``), in the vendors' own wire shapes as recorded
live on 2026-11-19 (Vertex ``generateContent``, Kie ``createTask`` / ``recordInfo``).
"""

from __future__ import annotations

import base64
import json
from pathlib import Path
from typing import Any

import httpx
import pytest

from flow_sdk.cloud_client.hub_proxy import HubProxy
from flow_sdk.core.compute_op.runner import run_op
from flow_sdk.endpoint_call import (
    CAPABILITIES,
    DECISION,
    IMAGE_GENERATE,
    KIND_HEADER,
    VIDEO_GENERATE,
    EndpointCallError,
    ImageRequest,
    ImageResult,
    Transport,
    VideoRequest,
    VideoResult,
    call,
    dialect_for,
)
from flow_sdk.external_apis.decision import jev
from flow_sdk.external_apis.image import vertex
from flow_sdk.external_apis.video import kie
from flow_sdk.external_apis.video import vertex as veo
from flow_sdk.fs_store.schema_registry import SchemaRegistry
from flow_sdk.schema.data_spec.compute_op_spec import ComputeOpSpec, EndpointOp, OpSubkind
from flow_sdk.schema.data_spec.decision_spec import DecisionResult, DecisionSpec
from flow_sdk.schema.data_spec.media_spec import FILE_UPLOAD
from flow_sdk.schema.data_spec.returned_value_spec import ExitCode
from tests.utils import decision_double

PNG = b"\x89PNG\r\n\x1a\n" + b"image-bytes"
CLIP = b"\x00\x00\x00\x18ftypmp42" + b"clip-bytes"
MINE = "11111111-2222-4333-8444-555555555555"
#: One allocation over two roots: it has no target of its own, so no host.
ALLOCATION = {"id": MINE, "name": "my media", "kinds": [], "enabled": True, "target": {}}
SERVES = {VIDEO_GENERATE: "api.kie.ai", IMAGE_GENERATE: "aiplatform.googleapis.com"}


def vertex_answer(*images: bytes, thought: bytes | None = None) -> dict[str, Any]:
    parts: list[dict[str, Any]] = []
    if thought is not None:
        parts.append({"text": "thinking", "thought": True})
        parts.append(
            {"inlineData": {"mimeType": "image/png", "data": base64.b64encode(thought).decode()}, "thought": True}
        )
    parts += [{"inlineData": {"mimeType": "image/png", "data": base64.b64encode(i).decode()}} for i in images]
    return {"candidates": [{"content": {"role": "model", "parts": parts}}], "modelVersion": "gemini-nano-banana-2.1"}


def kie_record(state: str, **extra: Any) -> dict[str, Any]:
    return {"code": 200, "msg": "success", "data": {"taskId": "task1234567890ab", "state": state, **extra}}


@pytest.fixture
def hub(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    """A signed-in box whose hub lists ONE endpoint serving both kinds. ``state`` steers the answers and
    records every ``invoke`` as ``(endpoint id, method, sub path, kind header, json, params)``."""
    decision_double.install(monkeypatch, tmp_path, instance="endpointcall")
    from flow_sdk.instance_settings.api_endpoint import _serves_cache

    _serves_cache.clear()
    state: dict[str, Any] = {
        "rows": [ALLOCATION],
        "serves": dict(SERVES),
        "sent": [],
        "image": httpx.Response(200, json=vertex_answer(PNG)),
        "created": httpx.Response(200, json=kie_record("waiting")),
        "records": [
            kie_record("generating"),
            kie_record("success", resultJson=json.dumps({"resultUrls": ["https://cdn.kie.test/clip.mp4"]})),
        ],
    }

    async def _hub_call(method, entity_type, entity_id=None, action=None, sub_path=None, **kwargs):
        if entity_type != "api_endpoint":
            return {"data": []}
        if action == "chain":
            return {"serves": state["serves"], "hops": []}
        return state["rows"] if action == "catalog" else {"data": []}

    async def _send(method, url, *, json=None, params=None, headers=None, **kwargs):
        tail = str(url).split("/api_endpoint/", 1)[1]
        entity_id, _, sub_path = tail.partition("/invoke/")
        state["sent"].append((entity_id, method, sub_path, (headers or {}).get(KIND_HEADER), json, params))
        if sub_path.endswith(":generateContent"):
            return state["image"]
        if sub_path == kie.CREATE_PATH:
            return state["created"]
        if sub_path.endswith(":predictLongRunning"):
            return httpx.Response(200, json={"name": "projects/p/locations/us-central1/operations/op1234567890abcdef"})
        if sub_path.endswith(":fetchPredictOperation"):
            return httpx.Response(200, json=state["operations"].pop(0))
        if sub_path == kie.UPLOAD_PATH:
            hosted = {"downloadUrl": f"https://files.kie.test/{json['uploadPath']}/{json['fileName']}"}
            return httpx.Response(200, json={"code": 200, "msg": "ok", "data": hosted})
        return httpx.Response(200, json=state["records"].pop(0)) if state["records"] else httpx.Response(500)

    async def _download(self, url: str, dest: Path) -> Path:
        state["downloaded"] = url
        dest.write_bytes(CLIP)
        return dest

    monkeypatch.setattr(HubProxy, "call", staticmethod(_hub_call))
    monkeypatch.setattr(HubProxy, "try_call", staticmethod(_hub_call))
    monkeypatch.setattr(HubProxy, "send", staticmethod(_send))
    monkeypatch.setattr(Transport, "download", _download)
    monkeypatch.setattr(kie, "POLL_SECONDS", 0.0)
    monkeypatch.setattr(veo, "POLL_SECONDS", 0.0)
    yield state
    _serves_cache.clear()
    decision_double.release()


# ── the capability table ─────────────────────────────────────────────────────


def test_every_capability_is_a_kind_with_registered_request_and_result_specs():
    assert CAPABILITIES == {
        DECISION: (DecisionSpec, DecisionResult),
        IMAGE_GENERATE: (ImageRequest, ImageResult),
        VIDEO_GENERATE: (VideoRequest, VideoResult),
    }
    for request_spec, result_spec in CAPABILITIES.values():
        for spec in (request_spec, result_spec):
            assert SchemaRegistry.kind_type(spec.spec_kind) is spec, spec.spec_kind


def test_a_dialect_is_chosen_by_kind_and_vendor_host_together():
    assert dialect_for(IMAGE_GENERATE, "aiplatform.googleapis.com") is vertex
    assert dialect_for(VIDEO_GENERATE, "API.KIE.AI") is kie
    assert dialect_for(DECISION, "api.typesafe.ai") is jev, "decisions use the same table"
    with pytest.raises(EndpointCallError) as refused:
        dialect_for(IMAGE_GENERATE, "api.kie.ai")  # the vendor is known, but not for this kind
    assert refused.value.reason == "no_endpoint"


# ── the dialects, as pure translations ───────────────────────────────────────


def test_vertex_asks_for_an_image_and_sends_reference_images_inline(tmp_path: Path):
    logo = tmp_path / "logo.png"
    logo.write_bytes(PNG)
    wire = vertex.to_wire(ImageRequest(prompt="a red ball", aspect_ratio="16:9", reference_images=[str(logo)]))
    assert wire["generationConfig"] == {"responseModalities": ["TEXT", "IMAGE"], "imageConfig": {"aspectRatio": "16:9"}}
    reference, text = wire["contents"][0]["parts"]
    assert reference["inlineData"] == {"mimeType": "image/png", "data": base64.b64encode(PNG).decode()}
    assert text == {"text": "a red ball"}
    assert vertex.path_for("gemini-3-pro-image") == "publishers/google/models/gemini-3-pro-image:generateContent"


def test_vertex_keeps_the_answer_images_and_drops_drafts_and_repeats():
    other = PNG + b"-second"
    assert vertex.images_of(vertex_answer(PNG, PNG, other, thought=b"draft")) == [
        ("image/png", PNG),
        ("image/png", other),
    ]
    with pytest.raises(EndpointCallError) as empty:
        vertex.images_of({"candidates": [{"content": {"parts": [{"text": "I cannot draw that."}]}}]})
    assert empty.value.reason == "bad_response"


def test_a_missing_reference_image_is_refused_before_anything_is_sent():
    with pytest.raises(EndpointCallError) as refused:
        vertex.to_wire(ImageRequest(prompt="x", reference_images=["/nowhere/logo.png"]))
    assert refused.value.reason == "invalid_request"


@pytest.mark.parametrize(
    ("model", "expected"),
    [
        ("", {"model": "wan/3-0-video", "resolution": "720P", "audio": True}),
        ("minimax-h3/text-to-video", {"model": "minimax-h3/text-to-video", "resolution": "768P"}),
        ("bytedance/seedance-2-5", {"model": "bytedance/seedance-2-5", "resolution": "720p", "generate_audio": True}),
        ("kling-4.0/reference-to-video", {"model": "kling-4.0/reference-to-video", "resolution": "720p"}),
    ],
)
def test_kie_spells_each_models_inputs_the_way_that_model_does(model: str, expected: dict):
    wire = kie.to_wire(VideoRequest(prompt="it rolls", model=model, duration_s=8, audio=True))
    assert wire["model"] == expected.pop("model")
    assert wire["input"] == {"prompt": "it rolls", "duration": 8, "aspect_ratio": "16:9", **expected}


def test_kie_takes_a_resolution_and_keyframes_when_they_are_given():
    wire = kie.to_wire(
        VideoRequest(
            prompt="p",
            model="wan/3-0-video",
            resolution="1080p",
            first_frame_url="https://x/a.png",
            last_frame_url="https://x/b.png",
        )
    )
    assert wire["input"]["resolution"] == "1080P"
    assert (
        wire["input"]["first_frame_url"] == "https://x/a.png" and wire["input"]["last_frame_url"] == "https://x/b.png"
    )


# ── video on Vertex (Veo): the same request, another vendor ─────────────────


def veo_done(clip: bytes) -> dict[str, Any]:
    video = {"bytesBase64Encoded": base64.b64encode(clip).decode(), "mimeType": "video/mp4"}
    return {"name": "op", "done": True, "response": {"raiMediaFilteredCount": 0, "videos": [video]}}


@pytest.mark.parametrize(("asked", "made"), [(1, 4), (4, 4), (5, 6), (6, 6), (7, 8), (30, 8)])
def test_veo_makes_the_shortest_clip_that_is_long_enough(asked: int, made: int):
    assert veo.to_wire(VideoRequest(prompt="p", duration_s=asked))["parameters"]["durationSeconds"] == made


def test_veo_takes_key_frames_as_bytes_and_refuses_a_url(tmp_path: Path):
    first = tmp_path / "first.png"
    first.write_bytes(PNG)
    wire = veo.to_wire(VideoRequest(prompt="p", first_frame=str(first), last_frame=str(first), audio=True))
    frame = {"bytesBase64Encoded": base64.b64encode(PNG).decode(), "mimeType": "image/png"}
    assert wire["instances"] == [{"prompt": "p", "image": frame, "lastFrame": frame}]
    assert wire["parameters"]["generateAudio"] is True and wire["parameters"]["resolution"] == "720p"
    with pytest.raises(EndpointCallError) as refused:
        veo.to_wire(VideoRequest(prompt="p", first_frame_url="https://x/a.png"))
    assert refused.value.reason == "invalid_request"


async def test_the_same_video_request_is_made_by_veo_when_vertex_serves_the_kind(hub, tmp_path: Path):
    hub["serves"][VIDEO_GENERATE] = "us-central1-aiplatform.googleapis.com"
    hub["operations"] = [{"name": "op"}, veo_done(CLIP)]

    clip = await call(VIDEO_GENERATE, VideoRequest(prompt="it rolls", audio=True), out_dir=tmp_path)

    assert Path(clip.file).read_bytes() == CLIP and Path(clip.file).name == "video-op1234567890.mp4"
    assert clip.model == "veo-3.1-fast-generate-001" and clip.job_id.endswith("/operations/op1234567890abcdef")
    assert [(path.rsplit(":", 1)[1], kind) for _, _, path, kind, _, _ in hub["sent"]] == [
        ("predictLongRunning", VIDEO_GENERATE),
        ("fetchPredictOperation", VIDEO_GENERATE),
        ("fetchPredictOperation", VIDEO_GENERATE),
    ]
    assert hub["sent"][1][4] == {"operationName": clip.job_id}


async def test_a_clip_veo_withholds_or_fails_names_the_job(hub, tmp_path: Path):
    hub["serves"][VIDEO_GENERATE] = "us-central1-aiplatform.googleapis.com"
    filtered = {"raiMediaFilteredCount": 1, "raiMediaFilteredReasons": ["a real person"]}
    hub["operations"] = [{"name": "op", "done": True, "response": filtered}]
    with pytest.raises(EndpointCallError) as withheld:
        await call(VIDEO_GENERATE, VideoRequest(prompt="p"), out_dir=tmp_path)
    assert withheld.value.reason == "failed" and "a real person" in withheld.value.message
    assert withheld.value.job_id.endswith("op1234567890abcdef")

    hub["operations"] = [{"name": "op", "done": True, "error": {"code": 13, "message": "internal"}}]
    with pytest.raises(EndpointCallError) as failed:
        await call(VIDEO_GENERATE, VideoRequest(prompt="p"), out_dir=tmp_path)
    assert failed.value.reason == "failed" and "internal" in failed.value.message


# ── the call, end to end through one endpoint ────────────────────────────────


async def test_local_key_frames_are_hosted_through_the_same_endpoint_before_the_job(hub, tmp_path: Path):
    first, last = tmp_path / "first.png", tmp_path / "last.png"
    first.write_bytes(PNG)
    last.write_bytes(PNG)

    await call(VIDEO_GENERATE, VideoRequest(prompt="it opens", first_frame=str(first), last_frame=str(last)))

    uploads = [sent for sent in hub["sent"] if sent[2] == kie.UPLOAD_PATH]
    assert [(endpoint, kind) for endpoint, _, _, kind, _, _ in uploads] == [(MINE, FILE_UPLOAD)] * 2
    assert uploads[0][4]["base64Data"] == "data:image/png;base64," + base64.b64encode(PNG).decode()
    job = next(body for _, _, path, _, body, _ in hub["sent"] if path == kie.CREATE_PATH)
    hosted = [job["input"]["first_frame_url"], job["input"]["last_frame_url"]]
    assert [url.rsplit("/", 1)[1] for url in hosted] == ["first.png", "last.png"]
    assert all(url.startswith("https://files.kie.test/frames/") for url in hosted) and hosted[0] != hosted[1]


async def test_a_missing_key_frame_is_refused_before_anything_is_sent(hub, tmp_path: Path):
    with pytest.raises(EndpointCallError) as refused:
        await call(VIDEO_GENERATE, VideoRequest(prompt="p", first_frame=str(tmp_path / "nope.png")))
    assert refused.value.reason == "invalid_request" and hub["sent"] == []


async def test_one_endpoint_makes_an_image_and_a_video_through_two_vendors(hub, tmp_path: Path):
    image = await call(IMAGE_GENERATE, ImageRequest(prompt="a red ball"), out_dir=tmp_path)
    clip = await call(
        VIDEO_GENERATE, VideoRequest(prompt="it rolls", model="minimax-h3/text-to-video"), out_dir=tmp_path
    )

    assert isinstance(image, ImageResult) and isinstance(clip, VideoResult)
    assert image.endpoint == clip.endpoint == f"api_endpoint-{MINE}", "both through the SAME endpoint"
    assert [Path(f).read_bytes() for f in image.files] == [PNG]
    assert image.model == "gemini-nano-banana-2.1"
    assert Path(clip.file).read_bytes() == CLIP and Path(clip.file).parent == tmp_path
    assert clip.job_id == "task1234567890ab" and clip.model == "minimax-h3/text-to-video"
    assert hub["downloaded"] == "https://cdn.kie.test/clip.mp4"

    assert {endpoint for endpoint, *_ in hub["sent"]} == {MINE}
    assert [(method, path, kind) for _, method, path, kind, _, _ in hub["sent"]] == [
        ("POST", "publishers/google/models/gemini-nano-banana-2.1:generateContent", IMAGE_GENERATE),
        ("POST", "api/v1/jobs/createTask", VIDEO_GENERATE),
        ("GET", "api/v1/jobs/recordInfo", VIDEO_GENERATE),
        ("GET", "api/v1/jobs/recordInfo", VIDEO_GENERATE),
    ]
    assert hub["sent"][2][5] == {"taskId": "task1234567890ab"}


async def test_a_plain_dict_is_validated_against_the_capabilitys_request_spec(hub, tmp_path: Path):
    image = await call(IMAGE_GENERATE, {"prompt": "a red ball"}, out_dir=tmp_path)
    assert isinstance(image, ImageResult) and len(image.files) == 1
    with pytest.raises(EndpointCallError) as refused:
        await call(IMAGE_GENERATE, {"prompt": "x", "duration_s": 5}, out_dir=tmp_path)
    assert refused.value.reason == "invalid_request"
    with pytest.raises(EndpointCallError) as unknown:
        await call("audio.generate", {"prompt": "x"}, out_dir=tmp_path)
    assert unknown.value.reason == "invalid_request"


async def test_a_root_tagged_with_the_kind_serves_it_at_its_own_host(hub, tmp_path: Path):
    hub["rows"] = [
        {"id": "aaaaaaaa-0000-4000-8000-000000000001", "name": "Vertex", "kinds": [IMAGE_GENERATE], "enabled": True,
         "target": {"base_url": "https://aiplatform.googleapis.com/v1/projects/p/locations/global"}},
    ]  # fmt: skip
    image = await call(IMAGE_GENERATE, ImageRequest(prompt="a red ball"), out_dir=tmp_path)
    assert image.endpoint == "api_endpoint-aaaaaaaa-0000-4000-8000-000000000001"
    with pytest.raises(EndpointCallError) as refused:
        await call(VIDEO_GENERATE, VideoRequest(prompt="p"), out_dir=tmp_path)
    assert refused.value.reason == "no_endpoint"


async def test_nothing_serving_the_kind_is_no_endpoint_and_nothing_is_sent(hub, tmp_path: Path):
    hub["serves"] = {VIDEO_GENERATE: "api.kie.ai"}
    with pytest.raises(EndpointCallError) as refused:
        await call(IMAGE_GENERATE, ImageRequest(prompt="x"), out_dir=tmp_path)
    assert refused.value.reason == "no_endpoint" and hub["sent"] == []
    with pytest.raises(EndpointCallError) as named:
        await call(VIDEO_GENERATE, VideoRequest(prompt="x"), endpoint="api_endpoint-not-mine", out_dir=tmp_path)
    assert named.value.reason == "no_endpoint"


async def test_a_refusal_from_the_hub_or_the_vendor_is_one_closed_reason(hub, tmp_path: Path):
    hub["image"] = httpx.Response(404, json={"error": "kind_not_served", "message": "no root serves it"})
    with pytest.raises(EndpointCallError) as unserved:
        await call(IMAGE_GENERATE, ImageRequest(prompt="x"), out_dir=tmp_path)
    assert unserved.value.reason == "no_endpoint" and unserved.value.status == 404
    hub["image"] = httpx.Response(429, json={"error": "rate_limited", "message": "slow down"})
    with pytest.raises(EndpointCallError) as limited:
        await call(IMAGE_GENERATE, ImageRequest(prompt="x"), out_dir=tmp_path)
    assert limited.value.reason == "rate_limited"
    # Kie reports a refusal inside a 200.
    hub["created"] = httpx.Response(200, json={"code": 402, "msg": "Credits insufficient", "data": None})
    with pytest.raises(EndpointCallError) as broke:
        await call(VIDEO_GENERATE, VideoRequest(prompt="x"), out_dir=tmp_path)
    assert broke.value.reason == "billing"


async def test_a_failed_job_names_the_job_so_it_can_be_looked_up(hub, tmp_path: Path):
    hub["records"] = [kie_record("fail", failMsg="content policy")]
    with pytest.raises(EndpointCallError) as failed:
        await call(VIDEO_GENERATE, VideoRequest(prompt="x"), out_dir=tmp_path)
    assert failed.value.reason == "failed" and failed.value.job_id == "task1234567890ab"
    assert "content policy" in failed.value.message
    assert "downloaded" not in hub


# ── the FlowCall block ───────────────────────────────────────────────────────


def _op(kind: str, **exe) -> ComputeOpSpec:
    """A block that declares its shapes: the capability's own request and result kinds."""
    request_spec, result_spec = CAPABILITIES[kind]
    return ComputeOpSpec(
        name=kind.replace(".", "-"),
        subkind=OpSubkind.ENDPOINT,
        exe_data=EndpointOp(kind=kind, **exe),
        input=request_spec.spec_kind,
        output=result_spec.spec_kind,
    )


def test_an_endpoint_op_names_a_capability_and_nothing_about_the_vendor():
    op = _op(VIDEO_GENERATE)
    assert op.exe_data.spec_kind == "compute_op.endpoint" and op.exe_data.input == "REQUEST"
    assert ComputeOpSpec.model_validate(op.model_dump(mode="json")).exe_data == op.exe_data, "it round-trips by subkind"
    with pytest.raises(ValueError, match="not a capability"):
        EndpointOp(kind="audio.generate")


async def test_an_endpoint_op_returns_the_capabilitys_result_as_its_value(hub, tmp_path: Path):
    image = await run_op(_op(IMAGE_GENERATE), trusted=True, workdir=tmp_path, input=ImageRequest(prompt="a red ball"))
    assert image.exit_code == ExitCode.OK and image.has_value
    assert isinstance(image.value, ImageResult) and Path(image.value.files[0]).parent == tmp_path

    request = VideoRequest(prompt="it rolls", model="minimax-h3/text-to-video")
    clip = await run_op(_op(VIDEO_GENERATE), trusted=True, workdir=tmp_path, input=request)
    assert clip.exit_code == ExitCode.OK and isinstance(clip.value, VideoResult)
    assert Path(clip.value.file).read_bytes() == CLIP and clip.value.endpoint == image.value.endpoint


async def test_an_endpoint_op_that_did_not_produce_its_value_is_not_a_completed_one(hub, tmp_path: Path):
    hub["records"] = [kie_record("fail", failMsg="content policy")]
    failed = await run_op(_op(VIDEO_GENERATE), trusted=True, workdir=tmp_path, input=VideoRequest(prompt="x"))
    assert failed.exit_code == ExitCode.NOT_YET and not failed.has_value and failed.ran
    assert "content policy" in failed.detail and "task1234567890ab" in failed.detail, "the job can be looked up"

    hub["serves"] = {}
    from flow_sdk.instance_settings.api_endpoint import _serves_cache

    _serves_cache.clear()
    unserved = await run_op(_op(IMAGE_GENERATE), trusted=True, workdir=tmp_path, input=ImageRequest(prompt="x"))
    assert unserved.exit_code == ExitCode.NOT_YET and not unserved.ran, "nothing was asked of any vendor"


async def test_an_endpoint_op_in_a_sequence_reads_its_request_from_scope(hub, tmp_path: Path):
    """Without a declared input the request is the scope value the op names (``REQUEST`` by default)."""
    scoped = ComputeOpSpec(name="draw", subkind=OpSubkind.ENDPOINT, exe_data=EndpointOp(kind=IMAGE_GENERATE))
    drawn = await run_op(scoped, trusted=True, workdir=tmp_path, values={"REQUEST": ImageRequest(prompt="a red ball")})
    assert drawn.exit_code == ExitCode.OK and isinstance(drawn.value, ImageResult)
    missing = await run_op(scoped, trusted=True, workdir=tmp_path, values={})
    assert missing.exit_code == ExitCode.NOT_APPLICABLE and not missing.ran


# ── decisions, on the same rails ─────────────────────────────────────────────


async def test_a_decision_is_one_more_kind_the_same_endpoint_can_serve(hub, monkeypatch: pytest.MonkeyPatch):
    """The one endpoint gains a third root (a decision API): ``decide()`` finds it by kind through the
    chain, names the kind on the call, and the unified ``call`` answers the same thing."""
    from flow_sdk.decision import decide, decision_endpoints

    hub["serves"]["decision"] = "api.typesafe.ai"
    sent: list[tuple] = []

    async def _send(method, url, *, json=None, headers=None, **kwargs):
        sent.append((str(url).split("/api_endpoint/", 1)[1], (headers or {}).get(KIND_HEADER)))
        return httpx.Response(200, json=decision_double.jev_answers(json, {"is_billing": 0.93}))

    monkeypatch.setattr(HubProxy, "send", staticmethod(_send))
    spec = DecisionSpec(
        state={"ticket": "charged twice"}, questions={"is_billing": {"type": "yes_no", "instructions": "billing?"}}
    )

    found = await decision_endpoints()
    assert [(o.id, o.host) for o in found] == [(MINE, "api.typesafe.ai")], "an allocation's vendor comes from its chain"
    decided = await decide(spec)
    through_call = await call(DECISION, spec)
    assert decided.answers["is_billing"].probability == through_call.answers["is_billing"].probability == 0.93
    assert decided.endpoint == through_call.endpoint == f"api_endpoint-{MINE}"
    assert sent == [(f"{MINE}/invoke/v1/systemone", DECISION)] * 2


# ── a machine with no hub login: its own sealed API budget ───────────────────


async def test_an_invite_box_calls_its_sealed_endpoint_with_the_key_the_hub_placed(
    hub, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
):
    """A signed-out box lists nothing on the hub. What the hub placed on it (origin, invoke-only key,
    what it serves) is the endpoint, and the call goes to that origin with the key -- never a login."""
    from flow_sdk.instance_settings import api_endpoint as listing

    hub["rows"] = []  # nothing this machine may list
    monkeypatch.setenv(listing.SEALED_URL_VAR, "https://0f0e0d0c-aaaa-bbbb-cccc-000000000001.hub.test")
    monkeypatch.setenv(listing.SEALED_KEY_VAR, "fp_box_key")
    monkeypatch.setenv(listing.SEALED_SERVES_VAR, json.dumps({IMAGE_GENERATE: "aiplatform.googleapis.com"}))
    listing.invalidate_api_endpoint_listing()
    seen: list[httpx.Request] = []

    def vendor(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json=vertex_answer(PNG))

    real_client = httpx.AsyncClient
    monkeypatch.setattr(
        httpx, "AsyncClient", lambda **kwargs: real_client(transport=httpx.MockTransport(vendor), **kwargs)
    )
    try:
        image = await call(IMAGE_GENERATE, ImageRequest(prompt="a red ball"), out_dir=tmp_path)
        with pytest.raises(EndpointCallError) as not_served:
            await call(VIDEO_GENERATE, VideoRequest(prompt="it rolls"), out_dir=tmp_path)
    finally:
        listing.invalidate_api_endpoint_listing()

    (request,) = seen
    assert request.url.host == "0f0e0d0c-aaaa-bbbb-cccc-000000000001.hub.test"
    assert request.url.path.endswith(":generateContent")
    assert request.headers["authorization"] == "Bearer fp_box_key"
    assert request.headers[KIND_HEADER] == IMAGE_GENERATE
    assert hub["sent"] == [], "nothing went through the hub login"
    assert Path(image.files[0]).read_bytes() == PNG
    assert image.endpoint == "api_endpoint-0f0e0d0c-aaaa-bbbb-cccc-000000000001"
    assert not_served.value.reason == "no_endpoint", "a kind the budget does not serve is not asked for"
