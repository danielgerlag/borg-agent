import {
  acceptToolId,
  askToolId,
  designerPersonaId,
  frontDeskPersonaId,
  operatorPersonaId,
  proposeToolId,
  reviseToolId,
  sendQuoteToolId,
  startMachineToolId,
  usePersonaToolId,
} from "./contract.js";

const model = "example.print-bench:scripted";

export const benchPersonas = [
  {
    id: designerPersonaId,
    name: "Designer",
    instructions:
      "Revise the fan bracket. Propose parameter changes. Do not send the quote or start the machine.",
    preferredModels: [model],
    allowedTools: [
      reviseToolId,
      acceptToolId,
      proposeToolId,
      askToolId,
      usePersonaToolId,
    ],
  },
  {
    id: frontDeskPersonaId,
    name: "Front desk",
    instructions: "Send the quote for the current passing revision.",
    preferredModels: [model],
    allowedTools: [sendQuoteToolId, usePersonaToolId],
  },
  {
    id: operatorPersonaId,
    name: "Operator",
    instructions: "Start the machine on the current passing revision.",
    preferredModels: [model],
    allowedTools: [startMachineToolId, usePersonaToolId],
  },
] as const;
