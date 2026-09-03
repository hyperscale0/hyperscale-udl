/**
 * Evidence profiles that an instrument action may require before it runs.
 * The public grammar and the runtime both read this table. A pair absent here
 * cannot gate an action.
 */
export interface UdlCheckEvidenceProfile {
  readonly family: string;
  readonly checkKind: string;
  readonly kindField?: string;
  readonly statusField: string;
  readonly statuses: readonly string[];
}

export const udlCheckEvidenceProfiles = [
  {
    family: "national_identity",
    checkKind: "identity_verification",
    kindField: "checkKind",
    statusField: "verificationStatus",
    statuses: [
      "requested",
      "waiting",
      "completed",
      "rejected",
      "expired",
      "error",
    ],
  },
  {
    family: "national_identity",
    checkKind: "contact_ownership_verification",
    kindField: "checkKind",
    statusField: "matchResult",
    statuses: ["match", "no_match"],
  },
  {
    family: "credit_bureau",
    checkKind: "consumer_inquiry",
    kindField: "inquiryType",
    statusField: "bureauStatus",
    statuses: ["returned", "acknowledged", "correction_required"],
  },
  {
    family: "credit_bureau",
    checkKind: "commercial_inquiry",
    kindField: "inquiryType",
    statusField: "bureauStatus",
    statuses: ["returned", "acknowledged", "correction_required"],
  },
  {
    family: "credit_bureau",
    checkKind: "facility_report",
    kindField: "inquiryType",
    statusField: "bureauStatus",
    statuses: ["returned", "acknowledged", "correction_required"],
  },
  {
    family: "sanctions_screening",
    checkKind: "screen",
    kindField: "checkKind",
    statusField: "screeningStatus",
    statuses: ["clear", "hit", "manual_review"],
  },
  {
    family: "enforcement_instrument",
    checkKind: "note_request",
    statusField: "requestStatus",
    statuses: ["debtor_approved", "debtor_rejected", "auto_cancelled"],
  },
] as const satisfies readonly UdlCheckEvidenceProfile[];

/** Returns the tenant-gateable evidence profile for one family and check. */
export function udlCheckEvidenceProfile(
  family: string,
  checkKind: string,
): UdlCheckEvidenceProfile | undefined {
  return udlCheckEvidenceProfiles.find(
    (profile) => profile.family === family && profile.checkKind === checkKind,
  );
}
