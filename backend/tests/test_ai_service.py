import asyncio
import json

import httpx
import pytest

from backend.app.config import Settings
from backend.app.services import ai_service
from backend.app.services.ai_service import (
    MEDICAL_DOCUMENT_SCHEMA,
    AIInsightService,
    _gemini_schema,
    _medical_analysis_from_json,
)


def test_used_up_quota_goes_straight_to_the_fallback_model(monkeypatch):
    calls = []

    def gemini(request):
        calls.append(request.url.path.rsplit("/", 1)[-1])
        if "primary" in request.url.path:
            return httpx.Response(429, json={"error": {"status": "RESOURCE_EXHAUSTED"}})
        if "down" in request.url.path:
            return httpx.Response(503, json={"error": {"status": "UNAVAILABLE"}})
        return httpx.Response(200, json={"candidates": [{"content": {"parts": [{"text": "{}"}]}, "finishReason": "STOP"}]})

    async def no_waiting(_seconds):
        raise AssertionError("a used-up quota does not come back in seconds, so it must not be retried")

    real_client = httpx.AsyncClient
    monkeypatch.setattr(ai_service.httpx, "AsyncClient", lambda **options: real_client(transport=httpx.MockTransport(gemini), **options))
    monkeypatch.setattr(ai_service.asyncio, "sleep", no_waiting)
    service = AIInsightService(Settings(ai_provider="google", google_ai_api_key="test-key",
                                        google_ai_model="primary", google_ai_fallback_model="fallback"))
    output = asyncio.run(service._gemini_generate(instruction="i", text="t", schema={"type": "object"}))
    assert output == "{}" and calls == ["primary:generateContent", "fallback:generateContent"]
    # With no model left, the person scanning gets a plain message, not the provider's quota vocabulary.
    exhausted = AIInsightService(Settings(ai_provider="google", google_ai_api_key="test-key",
                                          google_ai_model="primary", google_ai_fallback_model="primary-too"))
    with pytest.raises(ai_service.AIServiceError, match="Tính năng đọc ảnh đang quá tải"):
        asyncio.run(exhausted._gemini_generate(instruction="i", text="t", schema={"type": "object"}))

    # A provider outage is retried, then ends in the same plain message.
    async def no_delay(_seconds):
        calls.append("wait")

    monkeypatch.setattr(ai_service.asyncio, "sleep", no_delay)
    calls.clear()
    down = AIInsightService(Settings(ai_provider="google", google_ai_api_key="test-key",
                                     google_ai_model="down", google_ai_fallback_model="down-too"))
    with pytest.raises(ai_service.AIServiceError, match="Tính năng đọc ảnh đang quá tải"):
        asyncio.run(down._gemini_generate(instruction="i", text="t", schema={"type": "object"}))
    assert calls.count("wait") == 4 and len(calls) == 10  # three tries for each of the two models


def test_gemini_schema_uses_cross_model_compatible_subset():
    schema = _gemini_schema(MEDICAL_DOCUMENT_SCHEMA)
    assert schema["properties"]["document_date"]["type"] == "string"
    finding_schema = MEDICAL_DOCUMENT_SCHEMA["properties"]["genetic_findings"]["items"]
    assert {"transcript", "genome_build", "hgvs_genomic", "hgvs_coding", "hgvs_protein", "rsid"} <= set(finding_schema["properties"])

    serialized = json.dumps(schema)
    for fragile_keyword in ("additionalProperties", "minItems", "maxItems", "minLength", "maxLength", "pattern"):
        assert fragile_keyword not in serialized


def test_medical_output_normalizes_unknown_date_and_empty_copy():
    output = json.dumps({
        "document_type": "other",
        "document_date": "",
        "provider": "",
        "title": "",
        "summary": "",
        "metrics": [],
        "conditions": [],
        "medications": [],
        "recommendations": [],
        "warnings": [],
        "confidence": "low",
        "review_required": False,
        "source": "ai",
        "disclaimer": "",
    })

    analysis = _medical_analysis_from_json(output)
    assert analysis.document_date is None
    assert analysis.title == "Tài liệu sức khỏe cần xem lại"
    assert analysis.review_required is True
    assert analysis.disclaimer


def test_synthetic_genetic_report_is_verbatim_review_only():
    output = json.dumps({
        "document_type": "genetic_test_report",
        "document_date": "2026-01-15",
        "provider": "Phòng xét nghiệm giả lập",
        "title": "Phiếu xét nghiệm di truyền mô phỏng",
        "summary": "Một dòng kết quả giả lập để kiểm thử luồng trích xuất.",
        "metrics": [],
        "conditions": [],
        "vitals": {"systolic": 120, "diastolic": 80, "heart_rate": None, "spo2": None, "glucose": None},
        "own_conditions": ["breast_cancer"],
        "family_conditions": [{"member": "mother", "condition": "breast_cancer"}],
        "genetic_findings": [{
            "gene": "SYNTH-GENE-01",
            "variant": "c.123A>G",
            "transcript": "SYNTH-TX.1",
            "genome_build": "GRCh38 (mô phỏng)",
            "hgvs_genomic": "g.123A>G (mô phỏng)",
            "hgvs_coding": "c.123A>G",
            "hgvs_protein": "p.Lys41Arg (mô phỏng)",
            "rsid": "rsSYNTH1",
            "zygosity": "dị hợp tử (mô phỏng)",
            "classification": "VUS — kết luận giả lập",
            "condition": "Tình trạng mô phỏng",
            "source_excerpt": "Kết quả giả lập; không phải dữ liệu người bệnh.",
        }],
        "medications": [],
        "recommendations": [],
        "warnings": [],
        "confidence": "high",
        "review_required": False,
        "source": "ai",
        "disclaimer": "",
    }, ensure_ascii=False)

    analysis = _medical_analysis_from_json(output)
    finding = analysis.genetic_findings[0]
    assert analysis.document_type == "genetic_test_report"
    assert analysis.review_required is True
    assert finding.gene == "SYNTH-GENE-01"
    assert finding.variant == "c.123A>G"
    assert finding.transcript == "SYNTH-TX.1" and finding.genome_build == "GRCh38 (mô phỏng)"
    assert finding.hgvs_coding == "c.123A>G" and finding.rsid == "rsSYNTH1"
    assert finding.classification == "VUS — kết luận giả lập"
    assert "không phân loại lại biến thể" in analysis.disclaimer
    assert analysis.vitals.systolic is None
    assert analysis.own_conditions == [] and analysis.family_conditions == []
