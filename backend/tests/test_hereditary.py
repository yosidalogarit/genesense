import pytest

from backend.app.schemas import AccountProfile
from backend.app.services.hereditary import hereditary_screen
from backend.app.services.risk_engine import calculate_pgrs, risk_overview
from backend.app.schemas import AssessmentCreate

SIDES = {"father": "immediate", "mother": "immediate", "sibling": "immediate",
         "paternal-grandfather": "paternal", "paternal-grandmother": "paternal",
         "maternal-grandfather": "maternal", "maternal-grandmother": "maternal", "maternal-uncle": "maternal"}
RELATIONS = {"father": "father", "mother": "mother", "sibling": "sibling", "maternal-uncle": "uncle",
             "paternal-grandfather": "grandfather", "maternal-grandfather": "grandfather",
             "paternal-grandmother": "grandmother", "maternal-grandmother": "grandmother"}


def account(sex="female", known=(), parents_related="no", **relatives):
    """relatives: member id (with _ for -) -> list of conditions, or a dict of extra fields."""
    family = []
    for key in ("father", "mother", "sibling", "paternal_grandfather", "paternal_grandmother",
                "maternal_grandfather", "maternal_grandmother", "maternal_uncle"):
        member = key.replace("_", "-")
        value = relatives.get(key, [])
        extra = value if isinstance(value, dict) else {"conditions": value}
        conditions = extra.get("conditions", [])
        family.append({"member_id": member, "relation": RELATIONS[member], "side": SIDES[member],
                       "knowledge": "known" if conditions else "none"} | extra)
    return AccountProfile.model_validate({
        "display_name": "Thử", "health_consent": True, "parents_related": parents_related, "family_history": family,
        "profile": {"age": 35, "sex": sex, "height_cm": 160, "weight_kg": 55, "known_conditions": list(known)},
    })


def screen(acc):
    return {row["condition"]: row for row in hereditary_screen(acc)}


def test_clean_family_flags_nothing():
    rows = screen(account())
    assert {row["status"] for row in rows.values()} == {"not_seen"}
    assert all(row["advice"] == "" for row in rows.values())


def test_thalassemia_relative_or_related_parents_asks_doctor():
    assert screen(account(maternal_grandmother=["thalassemia"]))["thalassemia"]["status"] == "ask_doctor"
    related = screen(account(parents_related="yes"))["thalassemia"]
    assert related["status"] == "ask_doctor" and "họ hàng gần" in related["reasons"][0]
    assert screen(account(parents_related="unknown"))["thalassemia"]["status"] == "not_enough_info"
    assert screen(account(known=["thalassemia"]))["thalassemia"]["status"] == "diagnosed"


@pytest.mark.parametrize("relative", ["maternal_uncle", "maternal_grandfather", "mother", "sibling"])
def test_g6pd_on_mothers_side_asks_doctor(relative):
    row = screen(account(**{relative: ["g6pd"]}))["g6pd"]
    assert row["status"] == "ask_doctor"
    assert row["relatives"] == [relative.replace("_", "-")]


def test_g6pd_from_father_only_matters_for_daughters():
    assert screen(account(sex="female", father=["g6pd"]))["g6pd"]["status"] == "ask_doctor"
    assert screen(account(sex="male", father=["g6pd"]))["g6pd"]["status"] == "not_seen"
    assert screen(account(paternal_grandfather=["g6pd"]))["g6pd"]["status"] == "not_seen"


def test_brca_patterns():
    assert screen(account(maternal_grandmother=["ovarian_cancer"]))["brca"]["status"] == "ask_doctor"
    assert screen(account(father=["breast_cancer"]))["brca"]["status"] == "ask_doctor"           # male breast cancer
    brother = {"conditions": ["breast_cancer"], "affected_count": 1, "affected_brothers": 1}
    assert screen(account(sibling=brother))["brca"]["status"] == "ask_doctor"
    sister = {"conditions": ["breast_cancer"], "affected_count": 1, "affected_brothers": 0}
    assert screen(account(sibling=sister))["brca"]["status"] == "not_seen"                      # one case only
    two_on_mothers_side = screen(account(mother=["breast_cancer"], maternal_grandmother=["breast_cancer"]))["brca"]
    assert two_on_mothers_side["status"] == "ask_doctor"
    assert two_on_mothers_side["relatives"] == ["maternal-grandmother", "mother"]
    split_sides = screen(account(mother=["breast_cancer"], paternal_grandmother=["breast_cancer"]))["brca"]
    assert split_sides["status"] == "not_seen"
    assert screen(account(known=["breast_cancer"], mother=["breast_cancer"]))["brca"]["status"] == "ask_doctor"


def test_familial_hypercholesterolemia():
    assert screen(account(sibling=["familial_hypercholesterolemia"]))["familial_hypercholesterolemia"]["status"] == "ask_doctor"
    two_generations = screen(account(father=["dyslipidemia"], paternal_grandmother=["dyslipidemia"]))
    assert two_generations["familial_hypercholesterolemia"]["status"] == "ask_doctor"
    assert screen(account(father=["dyslipidemia"]))["familial_hypercholesterolemia"]["status"] == "not_seen"
    assert screen(account(known=["dyslipidemia"], mother=["dyslipidemia"]))["familial_hypercholesterolemia"]["status"] == "ask_doctor"


def test_unknown_parents_mean_not_enough_info():
    acc = account()
    for member in acc.family_history:
        if member.member_id in {"father", "mother"}:
            member.knowledge = "unknown"
    rows = screen(acc)
    assert {rows[key]["status"] for key in ("thalassemia", "brca", "familial_hypercholesterolemia")} == {"not_enough_info"}


def test_more_brothers_than_affected_siblings_is_refused():
    with pytest.raises(ValueError):
        account(sibling={"conditions": ["g6pd"], "affected_count": 1, "affected_brothers": 2})


def test_hereditary_conditions_do_not_move_the_score_or_the_levels():
    plain = account()
    hereditary = account(mother=["thalassemia", "g6pd", "ovarian_cancer"], maternal_uncle=["g6pd"])
    payload = lambda acc: AssessmentCreate(profile=acc.profile, family_history=acc.family_history, vitals={})
    assert calculate_pgrs(payload(hereditary)) == calculate_pgrs(payload(plain))
    overview = risk_overview(hereditary, None)
    assert {row["condition"] for row in overview["conditions"]} == {
        "hypertension", "diabetes", "cardiovascular", "stroke", "dyslipidemia", "breast_cancer", "colorectal_cancer"}
    assert len(overview["hereditary"]) == 4
