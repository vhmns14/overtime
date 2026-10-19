import "@fontsource/inter/latin-400.css";
import "@fontsource/inter/latin-600.css";
import "@fontsource/inter/latin-700.css";
import "@fontsource/jetbrains-mono/latin-400.css";
import "@fontsource/jetbrains-mono/latin-500.css";
import "@fontsource/jetbrains-mono/latin-700.css";
import "./styles.css";
import "./styles-office.css";
import officeUrl from "./assets/office.png";
import atlasUrl from "./assets/atlas.png";
import propsUrl from "./assets/props.png";
import { App } from "./app/app";

function load(src: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`failed to load ${src.slice(0, 40)}`));
    img.src = src;
  });
}

async function boot() {
  const [bg, atlas, props] = await Promise.all([load(officeUrl), load(atlasUrl), load(propsUrl)]);
  const app = new App(bg, atlas, props);
  app.mount();
  (window as unknown as { __overtime: App }).__overtime = app;
}

boot().catch((e) => {
  document.body.insertAdjacentHTML("beforeend", `<p style="position:fixed;inset:auto 0 0;padding:12px;background:#b03a1e;color:#fff;font:14px sans-serif">Overtime failed to start: ${String((e as Error).message)}</p>`);
});
