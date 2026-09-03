export type UdlIssueCategory =
  | "invalid_evolution"
  | "invalid_json"
  | "invalid_semantics"
  | "invalid_shape"
  | "invalid_utf8"
  | "resource_limit";

export type UdlDiagnosticFamily =
  | "admission"
  | "document"
  | "evolution"
  | "finance"
  | "gates"
  | "lifecycle"
  | "schema";

const diagnosticDefinitions = {
  UDL1001: {
    category: "invalid_utf8",
    family: "admission",
    title: "Invalid UTF-8",
    fix: "Encode the document as valid UTF-8.",
  },
  UDL1002: {
    category: "invalid_json",
    family: "admission",
    title: "Invalid JSON",
    fix: "Repair the JSON syntax before validation.",
  },
  UDL1003: {
    category: "invalid_shape",
    family: "admission",
    title: "Invalid document shape",
    fix: "Match the published UDL JSON Schema.",
  },
  UDL1004: {
    category: "resource_limit",
    family: "admission",
    title: "Resource limit exceeded",
    fix: "Reduce the source size, nesting, values, strings, references, or financial paths named by the message.",
  },

  UDL2001: {
    category: "invalid_semantics",
    family: "document",
    title: "Duplicate declaration",
    fix: "Give each declaration a unique name.",
  },
  UDL2002: {
    category: "invalid_semantics",
    family: "document",
    title: "Document law violation",
    fix: "Repair the declaration, subject contract, or derived effects named by the message.",
  },
  UDL2005: {
    category: "invalid_semantics",
    family: "document",
    title: "Derived effects mismatch",
    fix: "Regenerate the action effects from its clauses.",
  },

  UDL3001: {
    category: "invalid_semantics",
    family: "lifecycle",
    title: "Lifecycle is not closed",
    fix: "Declare every state and action transition, and make every state reachable.",
  },

  UDL4001: {
    category: "invalid_semantics",
    family: "finance",
    title: "Money graph violation",
    fix: "Balance every funded amount and close every hold on each lifecycle path.",
  },

  UDL5001: {
    category: "invalid_semantics",
    family: "gates",
    title: "Reference gate violation",
    fix: "Point the gate at a declared instrument, action, state, field, and reference.",
  },
  UDL5002: {
    category: "invalid_semantics",
    family: "gates",
    title: "Check requirement violation",
    fix: "Use a declared check with compatible evidence and recurrence.",
  },
  UDL5003: {
    category: "invalid_semantics",
    family: "gates",
    title: "Exposure gate violation",
    fix: "Use declared account and money fields for the exposure gate.",
  },
  UDL5004: {
    category: "invalid_semantics",
    family: "gates",
    title: "Aggregate law violation",
    fix: "Point the aggregate at compatible parent and child fields.",
  },
  UDL5005: {
    category: "invalid_semantics",
    family: "gates",
    title: "Settlement or payout violation",
    fix: "Use a declared settlement account and a compatible payout statement line.",
  },
  UDL5006: {
    category: "invalid_semantics",
    family: "gates",
    title: "Quote and commit violation",
    fix: "Declare one complete quote freeze set and one matching commit action.",
  },
  UDL5007: {
    category: "invalid_semantics",
    family: "gates",
    title: "Reconcile exception child violation",
    fix: "Name a declared child whose reference points back to this instrument.",
  },
  UDL5008: {
    category: "invalid_semantics",
    family: "gates",
    title: "Action clause violation",
    fix: "Repair the clause fields and keep incompatible clauses separate.",
  },
  UDL5009: {
    category: "invalid_semantics",
    family: "gates",
    title: "Reconcile exception amount field is missing or optional",
    fix: "Name the exception child's required money field in amountField.",
  },
  UDL5010: {
    category: "invalid_semantics",
    family: "gates",
    title: "Reconcile exception amount field has the wrong type",
    fix: "Point amountField at a money field declared by the exception child.",
  },
  UDL5011: {
    category: "invalid_semantics",
    family: "gates",
    title: "Reconcile exception reason field is missing or optional",
    fix: "Name the exception child's required text field in reasonField.",
  },
  UDL5012: {
    category: "invalid_semantics",
    family: "gates",
    title: "Reconcile exception reason field has the wrong type",
    fix: "Point reasonField at a required plain text field declared by the exception child.",
  },

  UDL6001: {
    category: "invalid_semantics",
    family: "schema",
    title: "Unsupported JSON Schema",
    fix: "Use only the sealed UDL JSON Schema subset.",
  },

  UDL7001: {
    category: "invalid_evolution",
    family: "evolution",
    title: "Stored contract changed",
    fix: "Keep stored identities and contracts unchanged, and add only allowed optional declarations.",
  },
  UDL7002: {
    category: "invalid_evolution",
    family: "evolution",
    title: "Version was not increased",
    fix: "Increase the product version for every semantic change.",
  },
} as const satisfies Record<
  string,
  {
    readonly category: UdlIssueCategory;
    readonly family: UdlDiagnosticFamily;
    readonly fix: string;
    readonly title: string;
  }
>;

export type UdlIssueCode = keyof typeof diagnosticDefinitions;

export interface UdlDiagnostic {
  readonly category: UdlIssueCategory;
  readonly code: UdlIssueCode;
  readonly family: UdlDiagnosticFamily;
  readonly fix: string;
  readonly title: string;
}

export const udlDiagnostics: readonly UdlDiagnostic[] = Object.entries(
  diagnosticDefinitions,
).map(([code, diagnostic]) => ({
  code: code as UdlIssueCode,
  ...diagnostic,
}));

export function udlDiagnostic(code: string): UdlDiagnostic | undefined {
  return udlDiagnostics.find((diagnostic) => diagnostic.code === code);
}

export interface UdlIssue {
  readonly category: UdlIssueCategory;
  readonly code: UdlIssueCode;
  readonly fix: string;
  readonly message: string;
  readonly path: string;
}

export function issue(
  code: UdlIssueCode,
  path: string,
  messageDetail?: string,
): UdlIssue {
  const diagnostic = diagnosticDefinitions[code];
  return {
    category: diagnostic.category,
    code,
    fix: diagnostic.fix,
    message: messageDetail ?? diagnostic.title,
    path,
  };
}
