// Copy the single-file Vite build into the Rust embed location.
import { copyFileSync, statSync } from "node:fs";
copyFileSync("dist/index.html", "../assets/app.html");
const kb = (statSync("../assets/app.html").size / 1024).toFixed(0);
console.log(`embedded → assets/app.html (${kb} KB)`);
