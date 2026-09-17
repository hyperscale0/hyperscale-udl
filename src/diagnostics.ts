export type UdlIssueCode =
  | "UDL1001"
  | "UDL1002"
  | "UDL1003"
  | "UDL1004"
  | "UDL2001"
  | "UDL2002"
  | "UDL2010"
  | "UDL3001"
  | "UDL4001"
  | "UDL5001"
  | "UDL7001"
  | "UDL7002";
export interface UdlIssue {
  code: UdlIssueCode;
  path: string;
  message: string;
  fix: string;
  category: string;
}
const fixes: Record<UdlIssueCode, string> = {
  UDL1001: "Encode the source as UTF-8.",
  UDL1002: "Repair JSON syntax.",
  UDL1003: "Use the UDL 3 typed grammar.",
  UDL1004: "Reduce the declared structure or expansion.",
  UDL2001: "Give each declaration a distinct name.",
  UDL2002: "Repair the named type or declaration.",
  UDL2010: "Remove the invocation cycle or reduce its expansion.",
  UDL3001: "Declare reachable states and one transition per action.",
  UDL4001:
    "Fund owned accounts before spending and close them with zero balances.",
  UDL5001: "Use a declared reference of the required type.",
  UDL7001: "Preserve existing instance meaning or recreate the estate.",
  UDL7002: "Increase the contract version.",
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
    category:
      code === "UDL1003"
        ? "invalid_shape"
        : code === "UDL1004"
          ? "resource_limit"
          : "invalid_semantics",
  };
}
export const udlDiagnostics = Object.entries(fixes).map(([code, fix]) => ({
  code,
  fix,
  title: fix,
  category: "invalid_semantics",
  family: "document",
}));
export const udlDiagnostic = (code: string) =>
  udlDiagnostics.find((d) => d.code === code);
