"""The assistant produces structured output without sending images or identifiers."""

import asyncio
import json

import pytest

from backend.app.config import Settings
from backend.app.services.ai_service import AIInsightService, AIServiceError


def test_assistant_uses_structured_context_and_parses_result(monkeypatch):
    service = AIInsightService(Settings(ai_provider="google", google_ai_api_key="test-key"))
    calls = []

    async def generate(**kwargs):
        calls.append(kwargs)
        return json.dumps({
            "summary": "Có tiền sử gia đình cần trao đổi với bác sĩ.",
            "findings": [{
                "topic": "Tiền sử gia đình", "evidence": "Tiền sử gia đình: bố đã khai tăng huyết áp.",
                "interpretation": "Thông tin này cần được bác sĩ xem cùng hồ sơ cá nhân.",
                "next_step": "Mang hồ sơ khi đi khám.",
            }],
            "missing_data": ["Chưa có chỉ số huyết áp gần đây."],
        }, ensure_ascii=False)

    monkeypatch.setattr(service, "_gemini_generate", generate)
    result = asyncio.run(service.review_clinical_context({"family_history": ["bố: tăng huyết áp"]}))
    assert result.source == "ai" and len(result.findings) == 1
    assert "image_bytes" not in calls[0]
    assert "family_history" in calls[0]["text"]
    assert "không chẩn đoán" in calls[0]["instruction"].lower()


def test_assistant_rejects_unstructured_model_output(monkeypatch):
    service = AIInsightService(Settings(ai_provider="google", google_ai_api_key="test-key"))

    async def generate(**kwargs):
        return "không phải JSON"

    monkeypatch.setattr(service, "_gemini_generate", generate)
    with pytest.raises(AIServiceError):
        asyncio.run(service.review_clinical_context({"profile": {}}))
