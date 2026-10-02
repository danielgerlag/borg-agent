import { mountDomainUi } from "@borg/example-ui-host/mount";
import ui, { fieldCatalogUiMetadata } from "../ui";
import "./styles.css";

void mountDomainUi(fieldCatalogUiMetadata, ui);
