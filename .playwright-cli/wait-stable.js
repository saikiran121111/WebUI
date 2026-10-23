async page => {
  const t0 = Date.now();
  let last = "";
  let lastChange = Date.now();
  while (Date.now() - t0 < 480000) {
    await new Promise(r => setTimeout(r, 3000));
    const txt = await page.evaluate(() => document.querySelector("main")?.innerText || "");
    if (txt !== last) { last = txt; lastChange = Date.now(); }
    else if (Date.now() - lastChange > 15000 && txt.length > 300) {
      return "STABLE after " + ((Date.now() - t0) / 1000).toFixed(0) + "s, main text len " + last.length;
    }
  }
  return "TIMEOUT 480s, main text len " + last.length;
}
