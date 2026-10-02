import {
  addToolId,
  deleteToolId,
  designerPersonaId,
  frontDeskPersonaId,
  operatorPersonaId,
  feedbackAskToolId,
  promptToolId,
  selectToolId,
  sendQuoteToolId,
  startMachineToolId,
  transformToolId,
  usePersonaToolId,
} from "./contract.js";

const model = "example.print-bench:scripted";

export const benchPersonas = [
  {
    id: designerPersonaId,
    name: "Designer",
    instructions:
      "Build solids from the designer's words. Add, move, rotate, scale, and delete. Ask when the shape or the size is missing. Do not send the quote or start the machine.",
    preferredModels: [model],
    allowedTools: [
      addToolId,
      transformToolId,
      deleteToolId,
      selectToolId,
      promptToolId,
      feedbackAskToolId,
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
