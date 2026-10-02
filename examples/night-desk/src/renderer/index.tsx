import { mountDomainUi } from "@borg/example-ui-host/mount";
import ui, { nightDeskUiMetadata } from "../ui";
import "./styles.css";

const root = document.getElementById("root");
if (!root) {
  throw new Error("Night desk root is missing");
}

void mountDomainUi(nightDeskUiMetadata, ui);
