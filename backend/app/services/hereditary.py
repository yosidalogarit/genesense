"""Screening for single-gene hereditary conditions from the family tree ("Bệnh di truyền" on the Di truyền tab).

Plain rules over who is affected, never a diagnosis and never a percentage: each condition either gets
"ask_doctor" with the reasons, or "not_seen", "not_enough_info" or "diagnosed". The rules and every sentence
still need a clinician's review (CLINICAL_REVIEW_CHECKLIST.md) before anything beyond a demo.
ponytail: no ages are collected (owner's choice), so the "early onset" criteria of the BRCA and familial
hypercholesterolemia guidelines are not used; add them if the form ever asks "diagnosed before 50".
"""
from __future__ import annotations

from ..schemas import AccountProfile, FamilyHistoryInput

PATERNAL_SIDE = {"father", "paternal-grandfather", "paternal-grandmother"}
MATERNAL_SIDE = {"mother", "maternal-grandfather", "maternal-grandmother", "maternal-uncle"}
MALE_RELATIVES = {"father", "paternal-grandfather", "maternal-grandfather", "maternal-uncle"}

ADVICE = {
    "thalassemia": "Hỏi bác sĩ về xét nghiệm máu sàng lọc người mang gen thalassemia, nhất là trước khi kết hôn hoặc mang thai.",
    "g6pd": "Hỏi bác sĩ về xét nghiệm men G6PD. Báo cho bác sĩ, dược sĩ biết tiền sử này trước khi dùng thuốc mới.",
    "brca": "Hỏi bác sĩ về tư vấn di truyền và xét nghiệm gen BRCA, cùng lịch tầm soát vú và buồng trứng phù hợp.",
    "familial_hypercholesterolemia": "Hỏi bác sĩ về xét nghiệm mỡ máu sớm cho bạn và cả nhà, kể cả con cái.",
}
PATTERNS = {"thalassemia": "recessive", "g6pd": "x_linked", "brca": "dominant", "familial_hypercholesterolemia": "dominant"}


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

    # Thalassemia: recessive. A child is affected when both parents carry the gene, so carriers look healthy.
    who = affected("thalassemia")
    reasons = []
    if who:
        reasons.append("Gia đình có người bị thalassemia. Người khỏe mạnh vẫn có thể mang gen mà không biết.")
    if account.parents_related == "yes":
        reasons.append("Bố mẹ có họ hàng gần, nên dễ cùng mang một gen bệnh lặn như thalassemia.")
    screens.append(result("thalassemia", reasons, who, unknown("father", "mother") or account.parents_related == "unknown",
                          "thalassemia" in known_personal))

    # G6PD deficiency: X-linked. Seen mostly in males on the mother's side; a father passes it to daughters only.
    maternal_line = affected("g6pd", {"mother", "maternal-grandfather", "maternal-uncle", "sibling"})
    reasons = []
    if maternal_line:
        reasons.append("Bệnh thường gặp ở nam giới bên ngoại (ông ngoại, cậu) và anh em trai.")
    father = affected("g6pd", {"father"})
    if father and female:
        reasons.append("Bố bị thiếu men G6PD: con gái thường mang gen này.")
    screens.append(result("g6pd", reasons, maternal_line + (father if female else []),
                          unknown("mother", "maternal-grandfather") or (female and unknown("father")),
                          "g6pd" in known_personal))

    # Hereditary breast and ovarian cancer (BRCA): dominant, passed on by either parent.
    reasons, relatives = [], []
    ovarian = affected("ovarian_cancer")
    if ovarian or "ovarian_cancer" in known_personal:
        reasons.append("Ung thư buồng trứng ở bạn hoặc người thân là dấu hiệu nên hỏi về gen BRCA.")
        relatives += ovarian
    sibling = members.get("sibling")
    male_breast = affected("breast_cancer", MALE_RELATIVES)
    if sibling and "breast_cancer" in sibling.conditions and sibling.affected_brothers:
        male_breast.append("sibling")
    if male_breast or (not female and "breast_cancer" in known_personal):
        reasons.append("Ung thư vú ở nam giới trong gia đình là dấu hiệu nên hỏi về gen BRCA.")
        relatives += male_breast

    def breast_cases(side: set[str]) -> int:
        # The person and their siblings share both sides of the family.
        count = len(affected("breast_cancer", side)) + ("breast_cancer" in known_personal)
        if sibling and "breast_cancer" in sibling.conditions:
            count += sibling.affected_count
        return count

    clusters = [side for side in (PATERNAL_SIDE, MATERNAL_SIDE) if breast_cases(side) >= 2]
    if clusters:
        reasons.append("Có từ hai người cùng một bên gia đình bị ung thư vú.")
        for side in clusters:
            relatives += affected("breast_cancer", side | {"sibling"})
    screens.append(result("brca", reasons, relatives, unknown("father", "mother")))

    # Familial hypercholesterolemia: dominant. A known diagnosis, or high cholesterol in two generations on one side.
    reasons, relatives = [], []
    diagnosed_relatives = affected("familial_hypercholesterolemia")
    if diagnosed_relatives:
        reasons.append("Người thân đã được chẩn đoán tăng cholesterol gia đình, một bệnh di truyền từ bố hoặc mẹ.")
        relatives += diagnosed_relatives
    lipid = set(affected("dyslipidemia"))
    personal_lipid = "dyslipidemia" in known_personal
    for parent, grandparents in (("father", {"paternal-grandfather", "paternal-grandmother"}),
                                 ("mother", {"maternal-grandfather", "maternal-grandmother"})):
        if parent in lipid and (lipid & grandparents or "sibling" in lipid or personal_lipid):
            reasons.append("Mỡ máu cao ở nhiều thế hệ cùng một bên gia đình có thể do gen.")
            relatives += [parent, *(lipid & (grandparents | {"sibling"}))]
            break
    screens.append(result("familial_hypercholesterolemia", reasons, relatives, unknown("father", "mother"),
                          "familial_hypercholesterolemia" in known_personal))
    return screens
