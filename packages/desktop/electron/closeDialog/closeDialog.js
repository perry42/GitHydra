// SPDX-License-Identifier: GPL-3.0-or-later
// Page script for the main-process close prompt. All copy lives here and is written with textContent only; main sends
// just a closed `reason` enum, so no string from main or the renderer ever reaches the DOM.
(function () {
  "use strict";
  var TEXT = {
    "second-attempt": {
      title: "Close GitHydra?",
      message:
        "You have unsaved edits in the editor. A Save / Discard / Cancel prompt is already open in the window. If you close now, those edits are lost.",
    },
    unresponsive: {
      title: "GitHydra is not responding",
      message: "You have unsaved edits in the editor. If you close now, those edits are lost.",
    },
  };
  // A key still held from the press that opened this window must not hit a button.
  var INPUT_GUARD_MS = 300;

  var theme = new URLSearchParams(location.search).get("theme") === "light" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", theme);

  var api = window.closeDialog;
  var closeBtn = document.getElementById("gh-close-anyway");
  var keepBtn = document.getElementById("gh-keep-open");
  var answered = false;
  var armed = false;

  function respond(choice) {
    if (answered || !armed) return;
    answered = true;
    closeBtn.disabled = true;
    keepBtn.disabled = true;
    api.respond(choice);
  }

  closeBtn.addEventListener("click", function () { respond("close"); });
  keepBtn.addEventListener("click", function () { respond("keep"); });
  document.addEventListener("contextmenu", function (e) { e.preventDefault(); });
  document.addEventListener("keydown", function (e) {
    if (!armed && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
    } else if (e.key === "Escape") {
      e.preventDefault();
      respond("keep");
    } else if (e.key === "Tab") {
      // Two tabbable controls only: keep focus cycling between them.
      var order = [closeBtn, keepBtn];
      var i = order.indexOf(document.activeElement);
      var next = e.shiftKey ? (i <= 0 ? order.length - 1 : i - 1) : i === order.length - 1 ? 0 : i + 1;
      e.preventDefault();
      order[next].focus();
    }
  });

  api.getReason().then(function (reason) {
    var t = TEXT[reason] || TEXT["second-attempt"];
    document.title = t.title;
    document.getElementById("gh-close-title").textContent = t.title;
    document.getElementById("gh-close-detail").textContent = t.message;
    keepBtn.focus();
    // Main shows the window only after this, so the first paint is complete and focused.
    api.ready().then(function () {
      setTimeout(function () { armed = true; }, INPUT_GUARD_MS);
    });
  });
})();
