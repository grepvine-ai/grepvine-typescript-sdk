// Grepvine chrome for the TypeDoc site: the Logo in the toolbar and the
// ThemeToggle, both using the markup and classes of components.css.
//
// TypeDoc stores the theme in localStorage under "tsd-theme" and mirrors it on
// <html data-theme>. Its value "os" means no choice yet; the design system's
// tokens only know "light" and the dark default, so "os" is resolved here to
// the preference the operating system reports.
(() => {
  const svg = "http://www.w3.org/2000/svg";
  const root = document.documentElement;
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)");
  // The mark: eight blocks in four rows; the second block of row two is the match.
  const blocks = [
    [2.5, 4, 27],
    [2.5, 10.5, 8],
    [12.5, 10.5, 9, "pink"],
    [23.5, 10.5, 6],
    [2.5, 17, 8],
    [12.5, 17, 7],
    [2.5, 23.5, 5.5],
    [10, 23.5, 4.5],
  ];

  const stored = () => {
    try {
      return localStorage.getItem("tsd-theme");
    } catch {
      return null;
    }
  };
  const resolve = (theme) =>
    theme === "light" || theme === "dark"
      ? theme
      : prefersDark.matches
        ? "dark"
        : "light";
  const apply = (theme) => {
    const next = resolve(theme);
    if (root.dataset.theme !== next) root.dataset.theme = next;
  };

  apply(stored());
  // TypeDoc's main.js writes "os" back when it starts; resolve it again.
  new MutationObserver(() => {
    if (root.dataset.theme === "os") apply("os");
  }).observe(root, { attributes: true, attributeFilter: ["data-theme"] });
  prefersDark.addEventListener("change", () => {
    if (!stored() || stored() === "os") apply("os");
  });

  const element = (name, attrs = {}) => {
    const el = document.createElementNS(svg, name);
    for (const [key, value] of Object.entries(attrs))
      el.setAttribute(key, value);
    return el;
  };

  const logoMark = () => {
    const mark = element("svg", {
      class: "logo-mark",
      viewBox: "0 0 32 32",
      "aria-hidden": "true",
    });
    const edge = element("g", { class: "logo-edge" });
    mark.append(edge);
    for (const [x, y, width, colour = "lime"] of blocks) {
      const rect = { x, y, width, height: 4.5 };
      edge.append(element("rect", rect));
      mark.append(element("rect", { ...rect, class: colour }));
    }
    return mark;
  };

  const toggleIcon = (name, paths) => {
    const icon = element("svg", {
      class: `icon-${name}`,
      viewBox: "0 0 24 24",
      "aria-hidden": "true",
    });
    for (const [tag, attrs] of paths) icon.append(element(tag, attrs));
    return icon;
  };

  const init = () => {
    let meta = document.querySelector('meta[name="theme-color"]');
    if (!meta) {
      meta = document.createElement("meta");
      meta.name = "theme-color";
      document.head.append(meta);
    }

    const title = document.querySelector(".tsd-page-toolbar .title");
    if (title) {
      const sub = document.createElement("span");
      sub.className = "logo-sub";
      sub.textContent = "typescript sdk";
      title.classList.add("logo");
      title.setAttribute("aria-label", "Grepvine TypeScript SDK home");
      title.replaceChildren(logoMark(), "grepvine", sub);
    }

    const button = document.createElement("button");
    button.type = "button";
    button.className = "theme-toggle";
    button.append(
      toggleIcon("sun", [
        ["rect", { x: 8, y: 8, width: 8, height: 8 }],
        [
          "path",
          {
            d: "M12 1.5v3M12 19.5v3M1.5 12h3M19.5 12h3M4.6 4.6l2.1 2.1M17.3 17.3l2.1 2.1M4.6 19.4l2.1-2.1M17.3 6.7l2.1-2.1",
          },
        ],
      ]),
      toggleIcon("moon", [
        [
          "path",
          { d: "M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z" },
        ],
      ]),
    );
    const sync = () => {
      const dark = root.dataset.theme !== "light";
      button.setAttribute(
        "aria-label",
        dark ? "Switch to light mode" : "Switch to dark mode",
      );
      meta.content = dark ? "#0b0b0e" : "#f4f4f7";
    };
    button.addEventListener("click", () => {
      const next = root.dataset.theme === "light" ? "dark" : "light";
      try {
        localStorage.setItem("tsd-theme", next);
      } catch {}
      apply(next);
      const select = document.getElementById("tsd-theme");
      if (select) select.value = next;
    });
    new MutationObserver(sync).observe(root, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });

    const search = document.getElementById("tsd-search-trigger");
    if (search) search.after(button);
    else document.querySelector(".tsd-toolbar-contents")?.append(button);
    sync();
  };

  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", init);
  else init();
})();
