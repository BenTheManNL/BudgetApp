/* Mijn budget – leest de tekst van een bonnetje met Tesseract.
   Dit draait helemaal op je eigen toestel: de foto gaat niet het internet op. */
let klaar = null;

function start() {
  if (!klaar) {
    klaar = (async () => {
      importScripts('tesseract-core-lstm.js');
      const m = await TesseractCore({});
      const res = await fetch('nld.traineddata');
      if (!res.ok) throw new Error('Het taalbestand kon niet worden geladen.');
      m.FS.writeFile('/nld.traineddata', new Uint8Array(await res.arrayBuffer()));
      const api = new m.TessBaseAPI();
      if (api.Init(null, 'nld', 1)) throw new Error('De lezer kon niet starten.');
      api.SetVariable('tessedit_pageseg_mode', '6');      // één blok tekst, regel voor regel
      api.SetVariable('preserve_interword_spaces', '1');  // ruimte tussen naam en prijs bewaren
      return { m, api };
    })();
    klaar.catch(() => { klaar = null; });
  }
  return klaar;
}

self.onmessage = async (e) => {
  const { id, beeld } = e.data;
  try {
    self.postMessage({ id, fase: 'laden' });
    const { m, api } = await start();
    self.postMessage({ id, fase: 'lezen' });
    m.FS.writeFile('/input', new Uint8Array(beeld));
    if (api.SetImageFile(1, 0) === 1) throw new Error('De foto kon niet worden geopend.');
    api.Recognize(null);
    const tekst = api.GetUTF8Text();
    api.Clear();
    self.postMessage({ id, tekst });
  } catch (err) {
    self.postMessage({ id, fout: String((err && err.message) || err) });
  }
};
