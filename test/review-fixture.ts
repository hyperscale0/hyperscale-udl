import type { UdlDocument } from "../src/index.js";

export function reviewDocument(): UdlDocument {
  return {
    udl: 4,
    version: 1,
    product: "review",
    title: "Review",
    currency: "SAR",
    parties: {},
    objects: [],
    instruments: [
      {
        id: "record",
        title: "Record",
        summary: "Record",
        fields: [],
        calculate: [],
        lifecycle: { states: ["open"], initial: "open", transitions: {} },
        actionOrder: ["create"],
        actions: {
          create: {
            summary: "Create",
            event: "record.created",
            actor: "caller",
            input: [],
            requires: [],
            moves: [],
          },
        },
      },
    ],
  };
}
