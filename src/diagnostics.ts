export type UdlIssueCode =
  | "economic_party_unbound"
  | "economic_move_invalid"
  | "economic_reservation_conflict"
  | "subject_field_conflict"
  | "subject_field_unknown"
  | "subject_requirement_missing"
  | "subject_adapter_unbound"
  | "subject_party_unbound"
  | "party_name_reserved"
  | "party_kind_mismatch"
  | "staff_role_unknown"
  | "product_party_unbound"
  | "product_party_invalid"
  | "UDL1003"
  | "UDL1004"
  | "UDL2001"
  | "UDL2002"
  | "UDL2010"
  | "UDL3001"
  | "UDL4001"
  | "UDL5001";
export interface UdlIssue {
  code: UdlIssueCode;
  path: string;
  message: string;
  fix: string;
  category: string;
  stranded?: {
    state: string;
    accounts: string[];
    actions: string[];
    paths: Record<string, string[]>;
  };
}
const fixes: Record<UdlIssueCode, string> = {
  economic_party_unbound:
    "Bind sourceParty to a money party retained by this attachment.",
  economic_move_invalid:
    "Declare a cash purpose on a cash transfer or its posting; use internal for non-cash accounting.",
  economic_reservation_conflict:
    "Keep the reservation's economics on its posting.",
  subject_field_conflict:
    "Rename the field or use matching types and constraints.",
  subject_field_unknown: "Name a declared subject requirement or object field.",
  subject_requirement_missing: "Supply the required action field.",
  subject_adapter_unbound: "Bind the required adapter declaration.",
  subject_party_unbound:
    "Bind the parameter to a subject role or declared party.",
  party_name_reserved:
    "Choose a party name other than owner, actor or operator.",
  party_kind_mismatch: "Use a business or subject role for money.",
  staff_role_unknown: "Use a registered staff permission role.",
  product_party_unbound:
    "Supply the consumed business in the Build party bindings.",
  product_party_invalid:
    "Bind a business participant in the same tenant and environment.",

  UDL1003: "Use the UDL 1 typed grammar.",
  UDL1004: "Reduce the declared structure or expansion.",
  UDL2001: "Give each declaration a distinct name.",
  UDL2002: "Repair the named type or declaration.",
  UDL2010: "Remove the invocation cycle or reduce its expansion.",
  UDL3001: "Declare reachable states and one transition per action.",
  UDL4001:
    "Fund owned accounts before spending and close them with zero balances.",
  UDL5001: "Use a declared reference of the required type.",
};
export function issue(
  code: UdlIssueCode,
  path: string,
  message: string,
): UdlIssue {
  return {
    code,
    path,
    message,
    fix: fixes[code],
    category: category(code),
  };
}
function category(code: string): string {
  return code === "UDL1003"
    ? "invalid_shape"
    : code === "UDL1004"
      ? "resource_limit"
      : "invalid_semantics";
}
