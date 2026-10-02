import { mountDomainUi } from "@borg/example-ui-host/mount";
import ui, { auctionClerkUiMetadata } from "../ui";
import "./styles.css";

void mountDomainUi(auctionClerkUiMetadata, ui);
