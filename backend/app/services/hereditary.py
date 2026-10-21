"""Screening for single-gene hereditary conditions from the family tree ("Bệnh di truyền" on the Di truyền tab).

Plain rules over who is affected, never a diagnosis and never a percentage: each condition either gets
"ask_doctor" with the reasons, or "not_seen", "not_enough_info" or "diagnosed". The rules and every sentence
still need a clinician's review (CLINICAL_REVIEW_CHECKLIST.md) before anything beyond a demo. Optional age at
diagnosis is stored only as context for the family tree/report; it does not change any rule or score.
"""
from __future__ import annotations

from ..schemas import AccountProfile, FamilyHistoryInput

PATERNAL_SIDE = {"father", "paternal-grandfather", "paternal-grandmother"}
MATERNAL_SIDE = {"mother", "maternal-grandfather", "maternal-grandmother", "maternal-uncle"}
MALE_RELATIVES = {"father", "paternal-grandfather", "maternal-grandfather", "maternal-uncle"}

ADVICE = {
    "thalassemia": "Trao đổi với bác sĩ về xét nghiệm máu phù hợp hoặc tư vấn di truyền, nhất là khi gia đình có người mắc bệnh hay bạn đang chuẩn bị có con.",
    "g6pd": "Nếu đã được chẩn đoán, hãy báo bác sĩ và dược sĩ trước khi dùng thuốc mới. Hỏi về xét nghiệm men G6PD; không tự ý ngừng thuốc.",
    "brca": "Hỏi bác sĩ xem tư vấn di truyền, xét nghiệm BRCA hoặc lịch tầm soát phù hợp với tiền sử của bạn có cần thiết không.",
    "familial_hypercholesterolemia": "Khi người thân đã được chẩn đoán FH, hỏi bác sĩ xem bạn và gia đình có cần xét nghiệm mỡ máu hoặc đánh giá thêm không.",
}
PATTERNS = {"thalassemia": "thalassemia", "g6pd": "x_linked", "brca": "brca", "familial_hypercholesterolemia": "fh"}


def _member(m: FamilyHistoryInput) -> str:
    return m.member_id or m.relation


def hereditary_screen(account: AccountProfile) -> list[dict]:
    members = {_member(m): m for m in account.family_history}
    known_personal = set(account.profile.known_conditions)
    female = account.profile.sex == "female"

    def affected(condition: str, ids: set[str] | None = None) -> list[str]:
        return [key for key, m in members.items() if condition in m.conditions and (ids is None or key in ids)]

    def unknown(*ids: str) -> bool:
        # A relative who was never filled in counts as unknown.
        return any(key not in members or members[key].knowledge == "unknown" for key in ids)

    def result(key: str, reasons: list[str], relatives: list[str], unsure: bool, diagnosed: bool = False) -> dict:
        status = "diagnosed" if diagnosed else "ask_doctor" if reasons else "not_enough_info" if unsure else "not_seen"
        return {"condition": key, "pattern": PATTERNS[key], "status": status, "reasons": reasons,
                "relatives": sorted(set(relatives)),
                "advice": ADVICE[key] if status == "ask_doctor" else ""}

    screens = []

    # Family-history flag only: thalassemia subtypes can have different inheritance patterns; no genotype is inferred.
    who = affected("thalassemia")
    reasons = []
    if who:
        reasons.append("Gia đình có người được khai báo mắc thalassemia. Người không có triệu chứng vẫn có thể mang biến thể gen.")
    if account.parents_related == "yes":
        reasons.append("Bố mẹ có quan hệ họ hàng gần; điều này có thể làm tăng khả năng cùng mang một số biến thể gen lặn, nhưng không xác định ai mang gen.")
    screens.append(result("thalassemia", reasons, who, unknown("father", "mother") or account.parents_related == "unknown",
                          "thalassemia" in known_personal))

    # G6PD deficiency: X-linked. Use family history only; do not infer a person's carrier status.
    maternal_line = affected("g6pd", {"mother", "maternal-grandfather", "maternal-uncle", "sibling"})
    reasons = []
    if maternal_line:
        reasons.append("Trong gia đình đã khai báo thiếu men G6PD ở phía mẹ hoặc anh chị em. Kiểu di truyền và biểu hiện cần được đánh giá theo từng người.")
    father = affected("g6pd", {"father"})
    if father and female:
        reasons.append("Bố đã được khai báo thiếu men G6PD. Con gái nhận nhiễm sắc thể X từ bố, nhưng mức biểu hiện có thể khác nhau; xét nghiệm mới xác định tình trạng.")
    screens.append(result("g6pd", reasons, maternal_line + (father if female else []),
                          unknown("mother", "maternal-grandfather") or (female and unknown("father")),
                          "g6pd" in known_personal))

    # BRCA family-history patterns can justify a clinical discussion; they do not identify a variant.
    reasons, relatives = [], []
    ovarian = affected("ovarian_cancer")
    if ovarian or "ovarian_cancer" in known_personal:
        reasons.append("Đã khai báo ung thư buồng trứng ở bạn hoặc người thân. Đây là chủ đề nên trao đổi với bác sĩ, không phải bằng chứng có biến thể BRCA.")
        relatives += ovarian
    sibling = members.get("sibling")
    male_breast = affected("breast_cancer", MALE_RELATIVES)
    if sibling and "breast_cancer" in sibling.conditions and sibling.affected_brothers:
        male_breast.append("sibling")
    if male_breast or (not female and "breast_cancer" in known_personal):
        reasons.append("Đã khai báo ung thư vú ở nam giới trong gia đình. Bác sĩ có thể đánh giá xem có cần tư vấn di truyền hay không.")
        relatives += male_breast

    def breast_cases(side: set[str]) -> int:
        # The person and their siblings share both sides of the family.
        count = len(affected("breast_cancer", side)) + ("breast_cancer" in known_personal)
        if sibling and "breast_cancer" in sibling.conditions:
            count += sibling.affected_count
        return count

    clusters = [side for side in (PATERNAL_SIDE, MATERNAL_SIDE) if breast_cases(side) >= 2]
    if clusters:
        reasons.append("Đã khai báo từ hai trường hợp ung thư vú cùng một bên gia đình; tiền sử này chưa xác định nguyên nhân do gen BRCA.")
        for side in clusters:
            relatives += affected("breast_cancer", side | {"sibling"})
    screens.append(result("brca", reasons, relatives, unknown("father", "mother")))

    # Family-history flag only: inheritance depends on the cause; no genotype is inferred from a cholesterol history.
    reasons, relatives = [], []
    diagnosed_relatives = affected("familial_hypercholesterolemia")
    if diagnosed_relatives:
        reasons.append("Người thân đã được khai báo chẩn đoán tăng cholesterol gia đình (FH); nên hỏi bác sĩ về việc đánh giá người thân.")
        relatives += diagnosed_relatives
    lipid = set(affected("dyslipidemia"))
    personal_lipid = "dyslipidemia" in known_personal
    for parent, grandparents in (("father", {"paternal-grandfather", "paternal-grandmother"}),
                                 ("mother", {"maternal-grandfather", "maternal-grandmother"})):
        if parent in lipid and (lipid & grandparents or "sibling" in lipid or personal_lipid):
            reasons.append("Đã khai báo mỡ máu cao qua nhiều thế hệ cùng một bên gia đình; hãy hỏi bác sĩ xem có cần đánh giá FH hoặc nguyên nhân khác không.")
            relatives += [parent, *(lipid & (grandparents | {"sibling"}))]
            break
    screens.append(result("familial_hypercholesterolemia", reasons, relatives, unknown("father", "mother"),
                          "familial_hypercholesterolemia" in known_personal))
    return screens
