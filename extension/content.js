(() => {
  const { DEFAULT_WEB_URL, handleFromX, claimLink, fetchNote } = CachetExtension;
  const buttonStyle = "border:1px solid #8b1a22;border-radius:999px;background:#fff7f2;color:#74151c;padding:7px 11px;font:600 12px/1.2 system-ui;cursor:pointer";
  const storageKey = "cachet.envelopes";

  function openCreate(handle) {
    const url = new URL("/", DEFAULT_WEB_URL);
    url.searchParams.set("to", handle);
    window.open(url.href, "_blank", "noopener");
  }

  function addButton(parent, key, label, click) {
    if (!parent || parent.querySelector(`[data-cachet-button="${key}"]`)) return;
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.cachetButton = key;
    button.textContent = label;
    button.setAttribute("aria-label", label);
    button.style.cssText = buttonStyle;
    button.addEventListener("click", click);
    parent.append(button);
  }

  function profileHandle(actions) {
    const attribute = actions.closest("[data-screen-name], [data-username]");
    const directHandle = handleFromX(attribute?.getAttribute("data-screen-name") || attribute?.getAttribute("data-username"));
    if (directHandle) return directHandle;
    const links = [...(actions.closest("[data-testid='primaryColumn']") || document).querySelectorAll('a[href]')];
    for (const link of links) {
      const handle = handleFromX(link.getAttribute("href"));
      if (handle && link.pathname?.replace(/^\//, "").split("/").length === 1) return handle;
    }
    return handleFromX(location.pathname);
  }

  function rewriteTextNode(node, oldText, replacement) {
    const text = node.nodeValue;
    const at = text.indexOf(oldText);
    if (at < 0) return false;
    node.parentNode.replaceChild(document.createTextNode(text.slice(0, at) + replacement + text.slice(at + oldText.length)), node);
    return true;
  }

  function saveEnvelope(id) {
    chrome.storage.local.get({ [storageKey]: [] }, ({ [storageKey]: records }) => {
      const existing = records.find(row => String(row.id) === String(id));
      const next = records.filter(row => String(row.id) !== String(id));
      next.unshift({ id: String(id), sats: existing?.sats ?? null, createdAt: existing?.createdAt || new Date().toISOString() });
      chrome.storage.local.set({ [storageKey]: next.slice(0, 100) });
    });
  }

  function offerRewrite(composer, claim, pastedText) {
    const area = composer.closest("[data-testid='dmComposerForm']") || composer.parentElement;
    if (!area || area.querySelector("[data-cachet-rewrite]")) return;
    const offer = document.createElement("button");
    offer.type = "button";
    offer.dataset.cachetRewrite = "true";
    offer.textContent = "Use red envelope link";
    offer.setAttribute("aria-label", "Replace claim link with a red envelope share link");
    offer.style.cssText = buttonStyle;
    offer.addEventListener("click", async () => {
      const walker = document.createTreeWalker(composer, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        if (rewriteTextNode(node, pastedText, claim.shareUrl)) break;
      }
      saveEnvelope(claim.id);
      offer.remove();
    });
    area.append(offer);
  }

  function inspect() {
    const profileActions = document.querySelector('[data-testid="userActions"]');
    if (profileActions) {
      const handle = profileHandle(profileActions);
      if (handle) addButton(profileActions, "profile", "Send a Bitcoin red envelope", () => openCreate(handle));
    }

    const composer = document.querySelector('[data-testid="dmComposerTextInput"]');
    if (composer) {
      const form = composer.closest("[data-testid='dmComposerForm']");
      const send = form?.querySelector('[data-testid="dmComposerSendButton"]');
      const toolbar = send?.parentElement || form || composer.parentElement;
      addButton(toolbar, "dm", "Send a Bitcoin red envelope", () => {
        const header = document.querySelector('[data-testid="DMConversationHeader"]');
        const recipient = handleFromX(header?.getAttribute("data-screen-name") || header?.getAttribute("data-username")) ||
          [...(header || composer).querySelectorAll('a[href]')].map(a => handleFromX(a.getAttribute("href"))).find(Boolean);
        if (recipient) openCreate(recipient);
      });
      if (!composer.dataset.cachetPasteListener) {
        composer.dataset.cachetPasteListener = "true";
        composer.addEventListener("input", () => {
          const text = composer.innerText || composer.value || "";
          const match = text.match(/https?:\/\/[^\s]+/);
          const claim = match && claimLink(match[0]);
          if (claim) {
            saveEnvelope(claim.id);
            offerRewrite(composer, claim, match[0]);
          }
        });
      }
    }
  }

  new MutationObserver(inspect).observe(document.documentElement, { childList: true, subtree: true });
  inspect();
})();
