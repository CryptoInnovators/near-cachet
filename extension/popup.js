(() => {
  const list = document.querySelector("#envelopes");
  const status = document.querySelector("#status");
  chrome.storage.local.get({ "cachet.envelopes": [] }, async ({ "cachet.envelopes": records }) => {
    if (!records.length) {
      status.textContent = "Share a cachet claim link in an X DM to save it here.";
      return;
    }
    status.textContent = "Reading live state from NEAR testnet…";
    const results = await Promise.all(records.map(async record => {
      try { return { record, note: await CachetExtension.fetchNote(record.id) }; }
      catch (error) { return { record, error }; }
    }));
    for (const { record, note, error } of results) {
      const row = document.createElement("li");
      const id = document.createElement("strong");
      id.textContent = `Envelope #${record.id}`;
      const detail = document.createElement("span");
      detail.textContent = error ? "Live state unavailable" : CachetExtension.formatState(note);
      row.append(id, detail);
      list.append(row);
      if (!error) record.sats = note.utxo?.sats ?? null;
    }
    chrome.storage.local.set({ "cachet.envelopes": results.map(({ record }) => record) });
    status.textContent = "Live state · NEAR testnet";
  });
})();
