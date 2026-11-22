import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { initAppTheme } from "./lib/appTheme";
import "./index.css";

initAppTheme();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
