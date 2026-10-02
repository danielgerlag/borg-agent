import { render } from "solid-js/web";
import { Bench } from "./bench.js";
import "./styles.css";

const root = document.getElementById("root");
if (!root) {
  throw new Error("Print bench root is missing");
}
render(() => <Bench />, root);
