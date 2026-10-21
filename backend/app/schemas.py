from datetime import date, datetime, timedelta, timezone
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, computed_field, model_validator


# The last four are single-gene hereditary conditions for the "Bệnh di truyền" screen (services/hereditary.py);
# they do not move the family-risk levels or the score.
Condition = Literal["hypertension", "diabetes", "cardiovascular", "stroke", "dyslipidemia", "breast_cancer", "colorectal_cancer",
                    "ovarian_cancer", "thalassemia", "g6pd", "familial_hypercholesterolemia"]
Relation = Literal["father", "mother", "sibling", "grandfather", "grandmother", "uncle"]
FamilyMember = Literal["father", "mother", "sibling", "paternal-grandfather", "paternal-grandmother",
                       "maternal-grandfather", "maternal-grandmother", "maternal-uncle"]
FamilyHistorySource = Literal["self_reported", "relative_reported", "document_checked", "clinician_reviewed", "unknown"]
# "device": a GeneSense measuring device (the UNIHIKER K10 sketch) handed the reading over through a link.
MeasurementSource = Literal["manual", "ble", "simulation", "document", "device"]


class ProfileInput(BaseModel):
    age: int = Field(ge=1, le=120)
    sex: Literal["female", "male", "other"]
    height_cm: float = Field(ge=80, le=250)
    weight_kg: float = Field(ge=20, le=350)
    smoker: bool = False
    activity_minutes_week: int = Field(default=120, ge=0, le=3000)
    known_conditions: list[Condition] = Field(default_factory=list)

    @computed_field
    @property
    def bmi(self) -> float:
        return round(self.weight_kg / ((self.height_cm / 100) ** 2), 1)


class FamilyHistoryInput(BaseModel):
    relation: Relation
    conditions: list[Condition] = Field(default_factory=list)
    member_id: str | None = None
    side: Literal["immediate", "paternal", "maternal"] = "immediate"
    knowledge: Literal["unknown", "none", "known"] = "unknown"
    # Provenance is context only and never changes a score or screening rule.
    source: FamilyHistorySource = "self_reported"
    last_confirmed_on: date | None = None
    # Optional age when the earliest listed condition was first diagnosed; context only, not a score input.
    age_at_diagnosis: int | None = Field(default=None, ge=1, le=120)
    # How many people this entry stands for; only the "siblings" and "maternal uncles" entries use more than one.
    affected_count: int = Field(default=1, ge=1, le=10)
    # Of the affected siblings, how many are brothers (the rest are sisters). Needed for patterns seen in males.
    affected_brothers: int = Field(default=0, ge=0, le=10)

    @model_validator(mode="after")
    def consistent_history(self):
        if self.knowledge == "none" and self.conditions:
            raise ValueError("Không thể chọn không có bệnh cùng với một bệnh đã biết.")
        if self.knowledge == "unknown":
            self.source = "unknown"
            self.last_confirmed_on = None
        elif self.source == "unknown":
            raise ValueError("Hãy chọn nguồn thông tin hoặc đánh dấu tiền sử chưa rõ.")
        if self.last_confirmed_on and self.last_confirmed_on > date.today():
            raise ValueError("Ngày xác nhận tiền sử không thể ở tương lai.")
        if self.age_at_diagnosis is not None and self.knowledge != "known":
            raise ValueError("Chỉ ghi tuổi chẩn đoán khi tiền sử bệnh đã biết.")
        if self.affected_brothers > self.affected_count:
            raise ValueError("Số anh em trai mắc bệnh không thể lớn hơn tổng số anh chị em mắc bệnh.")
        return self


class VitalSample(BaseModel):
    timestamp: datetime | None = None
    heart_rate: float | None = Field(default=None, ge=20, le=260)
    systolic: float | None = Field(default=None, ge=50, le=260)
    diastolic: float | None = Field(default=None, ge=30, le=180)
    spo2: float | None = Field(default=None, ge=50, le=100)
    glucose: float | None = Field(default=None, ge=20, le=600)
    # Shown with the reading only; the safety ranges are the same for every context (clinical review pending).
    glucose_context: Literal["fasting", "after_meal"] | None = None

    @model_validator(mode="after")
    def context_needs_glucose(self):
        if self.glucose is None:
            self.glucose_context = None
        return self


class AssessmentCreate(BaseModel):
    profile: ProfileInput
    family_history: list[FamilyHistoryInput] = Field(default_factory=list, max_length=20)
    vitals: VitalSample
    samples: list[VitalSample] = Field(default_factory=list, max_length=120)


class ScoreBreakdown(BaseModel):
    pgrs: float
    brs: float
    vitals: float
    overall: float


class Thresholds(BaseModel):
    attention: float
    alert: float


class AlertItem(BaseModel):
    metric: str
    severity: Literal["safe", "attention", "alert"]
    message: str


class HealthTip(BaseModel):
    title: str
    action: str
    reason: str
    priority: Literal["low", "medium", "high"]


class AIInsight(BaseModel):
    summary: str
    explanations: list[str]
    tips: list[HealthTip]
    follow_up: str
    source: Literal["ai", "rules"] = "rules"


class AssessmentResult(BaseModel):
    id: str | None = None
    created_at: datetime
    risk_level: Literal["safe", "attention", "alert"]
    scores: ScoreBreakdown
    thresholds: Thresholds
    alerts: list[AlertItem]
    insight: AIInsight
    disclaimer: str
    measurement_source: MeasurementSource = "manual"
    measured_vitals: VitalSample | None = None


class AssessmentHistoryItem(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    created_at: datetime
    risk_level: str
    overall_score: float
    pgrs_score: float
    brs_score: float
    vital_score: float
    vitals: dict


class FeedbackCreate(BaseModel):
    assessment_id: str | None = None
    rating: int = Field(ge=1, le=5)
    message: str = Field(default="", max_length=2000)

    @model_validator(mode="after")
    def require_content(self) -> "FeedbackCreate":
        if not self.message.strip() and self.rating < 1:
            raise ValueError("Feedback is empty")
        return self


class FeedbackResult(BaseModel):
    id: str
    status: Literal["received"] = "received"


class AccountProfile(BaseModel):
    display_name: str = Field(min_length=1, max_length=100)
    profile: ProfileInput
    family_history: list[FamilyHistoryInput] = Field(default_factory=list, max_length=20)
    personal_notes: str = Field(default="", max_length=2000)
    paternal_notes: str = Field(default="", max_length=2000)
    maternal_notes: str = Field(default="", max_length=2000)
    ai_consent: bool = False
    # Medication data stays private unless the patient explicitly enables caregiver access.
    share_medications: bool = False
    # Parents related by blood raise the chance of recessive hereditary conditions such as thalassemia.
    parents_related: Literal["yes", "no", "unknown"] = "unknown"
    health_consent: Literal[True]

    @model_validator(mode="after")
    def validate_profile(self):
        self.display_name = self.display_name.strip()
        if not self.display_name:
            raise ValueError("Vui lòng nhập tên hiển thị.")
        member_ids = [member.member_id for member in self.family_history if member.member_id]
        if len(set(member_ids)) != len(member_ids):
            raise ValueError("Một người thân chỉ được khai báo một lần.")
        return self


class MeasurementCreate(BaseModel):
    vitals: VitalSample
    samples: list[VitalSample] = Field(default_factory=list, max_length=120)
    source: MeasurementSource = "manual"
    client_id: str | None = Field(default=None, min_length=36, max_length=36, pattern=r"^[0-9a-fA-F-]{36}$")
    # The date printed on a scanned document. Only "document" readings carry one; every other reading is dated now.
    measured_on: date | None = None

    @model_validator(mode="after")
    def require_measurement(self):
        # Manual readings use the id to sync once; device links use it so tapping the same link twice saves once.
        if self.client_id and self.source not in {"manual", "device"}:
            raise ValueError("Mã chống lưu trùng chỉ dùng cho chỉ số nhập tay hoặc từ máy đo GeneSense.")
        if self.vitals.timestamp is not None:
            if self.vitals.timestamp.tzinfo is None:
                raise ValueError("Thời gian ghi nhận cần có múi giờ.")
            now = datetime.now(timezone.utc)
            measured_at = self.vitals.timestamp.astimezone(timezone.utc)
            if measured_at > now + timedelta(minutes=5) or measured_at < now - timedelta(days=90):
                raise ValueError("Thời gian ghi nhận không hợp lệ.")
        if self.measured_on is not None:
            if self.source != "document":
                raise ValueError("Chỉ số từ giấy tờ mới được ghi ngày khác hôm nay.")
            # One day of slack: the user's "today" can be ahead of the server's UTC date.
            if not date(1950, 1, 1) <= self.measured_on <= datetime.now(timezone.utc).date() + timedelta(days=1):
                raise ValueError("Ngày trên giấy tờ không hợp lệ.")
        values = self.vitals.model_dump(exclude={"timestamp"})
        if all(value is None for value in values.values()):
            raise ValueError("Vui lòng cung cấp ít nhất một chỉ số.")
        if (self.vitals.systolic is None) != (self.vitals.diastolic is None):
            raise ValueError("Huyết áp cần cả tâm thu và tâm trương.")
        if self.vitals.systolic is not None and self.vitals.systolic <= self.vitals.diastolic:
            raise ValueError("Huyết áp tâm thu phải lớn hơn tâm trương.")
        return self


class MedicalMetric(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=120)
    value: str = Field(min_length=1, max_length=120)
    unit: str = Field(default="", max_length=40)
    reference_range: str = Field(default="", max_length=120)
    flag: Literal["normal", "high", "low", "abnormal", "unknown"] = "unknown"


class MedicalMedication(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=160)
    dose: str = Field(default="", max_length=120)
    # How to take it, copied word for word from the prescription. The slots below are worked out from it in code.
    frequency: str = Field(default="", max_length=160)
    strength: str = Field(default="", max_length=60)
    meal: Literal["before", "after", "any", "unknown"] = "unknown"
    days: int = Field(default=0, ge=0, le=365)
    unsure: bool = False
    morning: bool = False
    noon: bool = False
    afternoon: bool = False
    evening: bool = False


class MedicationFields(BaseModel):
    """A medicine as stored. No slot ticked means "taken when needed"."""
    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=160)
    strength: str = Field(default="", max_length=60)
    amount: str = Field(default="", max_length=60)
    morning: bool = False
    noon: bool = False
    afternoon: bool = False
    evening: bool = False
    meal: Literal["before", "after", "any"] = "any"
    start_date: date
    days: int | None = Field(default=None, ge=1, le=365)
    note: str = Field(default="", max_length=200)


class MedicationInput(MedicationFields):
    """A medicine as the user confirmed it. "Khi cần" must be ticked explicitly, so a forgotten time
    of day is refused instead of being saved as "when needed". The flag is checked, not stored."""
    as_needed: bool = Field(default=False, exclude=True)

    @model_validator(mode="after")
    def named(self):
        self.name = self.name.strip()
        if not self.name:
            raise ValueError("Vui lòng nhập tên thuốc.")
        if self.as_needed == any((self.morning, self.noon, self.afternoon, self.evening)):
            raise ValueError("Hãy chọn buổi uống, hoặc chọn Khi cần.")
        return self


class MedicationResult(MedicationFields):
    model_config = ConfigDict(from_attributes=True)

    id: str


class MedicationIntakeUpdate(BaseModel):
    scheduled_on: date
    taken: bool


class MedicationIntakeResult(BaseModel):
    medication_id: str
    scheduled_on: date
    slot: Literal["morning", "noon", "afternoon", "evening"]
    taken: bool = True
    taken_at: datetime | None = None


class BloodPressureAverage(BaseModel):
    count: int
    systolic: float | None
    diastolic: float | None


class WeeklyBloodPressureSummary(BaseModel):
    days: int = 7
    morning: BloodPressureAverage
    evening: BloodPressureAverage


class DocumentVitals(BaseModel):
    """Readings printed on the document, as the AI read them. Ranges are checked when the user applies them."""
    model_config = ConfigDict(extra="forbid")

    systolic: float | None = None
    diastolic: float | None = None
    heart_rate: float | None = None
    spo2: float | None = None
    glucose: float | None = None


class DocumentFamilyCondition(BaseModel):
    model_config = ConfigDict(extra="forbid")

    member: FamilyMember
    condition: Condition


class MedicalGeneticFinding(BaseModel):
    """Verbatim fields transcribed from a report; this model does not classify variants."""
    model_config = ConfigDict(extra="forbid")

    gene: str = Field(default="", max_length=60)
    variant: str = Field(default="", max_length=240)
    transcript: str = Field(default="", max_length=100)
    genome_build: str = Field(default="", max_length=40)
    hgvs_genomic: str = Field(default="", max_length=180)
    hgvs_coding: str = Field(default="", max_length=180)
    hgvs_protein: str = Field(default="", max_length=180)
    rsid: str = Field(default="", max_length=40)
    zygosity: str = Field(default="", max_length=100)
    classification: str = Field(default="", max_length=120)
    condition: str = Field(default="", max_length=200)
    source_excerpt: str = Field(default="", max_length=300)
    # A user-recorded source review, not a clinical verification or a GeneSense classification.
    evidence_review_on: date | None = None
    evidence_review_source: Literal["clinvar", "clingen", "care_team"] | None = None


class MedicalDocumentAnalysis(BaseModel):
    model_config = ConfigDict(extra="forbid")

    document_type: Literal["lab_result", "genetic_test_report", "prescription", "discharge_note", "imaging_report", "vaccination", "other"]
    document_date: str | None = Field(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$")
    provider: str = Field(default="", max_length=180)
    title: str = Field(min_length=1, max_length=180)
    summary: str = Field(min_length=1, max_length=1200)
    metrics: list[MedicalMetric] = Field(default_factory=list, max_length=50)
    conditions: list[str] = Field(default_factory=list, max_length=30)
    # What the app can put into the profile after the user has checked it. Records saved earlier have none.
    vitals: DocumentVitals = Field(default_factory=DocumentVitals)
    own_conditions: list[Condition] = Field(default_factory=list, max_length=7)
    family_conditions: list[DocumentFamilyCondition] = Field(default_factory=list, max_length=49)
    # AI may copy these fields from a genetic report, but must not infer or reclassify them.
    genetic_findings: list[MedicalGeneticFinding] = Field(default_factory=list, max_length=20)
    medications: list[MedicalMedication] = Field(default_factory=list, max_length=30)
    recommendations: list[str] = Field(default_factory=list, max_length=20)
    warnings: list[str] = Field(default_factory=list, max_length=20)
    confidence: Literal["high", "medium", "low"]
    review_required: bool = True
    source: Literal["ai", "manual"] = "ai"
    disclaimer: str = Field(min_length=1, max_length=500)

    @model_validator(mode="after")
    def genetic_report_requires_review(self):
        if self.document_type == "genetic_test_report":
            self.review_required = True
            if not self.disclaimer:
                self.disclaimer = "GeneSense chỉ chép nội dung trên phiếu; không xác định nguy cơ, không chẩn đoán và không phân loại lại biến thể."
        if self.source == "manual":
            if self.document_type != "genetic_test_report":
                raise ValueError("Nhập tay chỉ hỗ trợ phiếu xét nghiệm di truyền.")
            if not self.genetic_findings or any(not (finding.gene.strip() or finding.variant.strip()) for finding in self.genetic_findings):
                raise ValueError("Mỗi mục nhập tay cần có tên gen hoặc biến thể ghi trên phiếu.")
        return self


class MedicalDocumentAnalyzeResult(BaseModel):
    analysis: MedicalDocumentAnalysis
    document_hash: str = Field(pattern=r"^[a-f0-9]{64}$")
    privacy_note: str


class MedicalRecordCreate(BaseModel):
    analysis: MedicalDocumentAnalysis
    document_hash: str = Field(pattern=r"^[a-f0-9]{64}$")
    health_consent: Literal[True]


class MedicalRecordResult(BaseModel):
    id: str
    created_at: datetime
    analysis: MedicalDocumentAnalysis


class GeneticEvidenceReviewInput(BaseModel):
    source: Literal["clinvar", "clingen", "care_team"]


class DeleteAccountRequest(BaseModel):
    confirm_delete: Literal[True]
