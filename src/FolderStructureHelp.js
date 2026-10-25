/* (C) Copyright 2026, by Ross Richardson
 * Shared folder-layout help, anchored beside its link for pointer and keyboard use.
 * @author ross richardson
 */
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";

export default function FolderStructureHelp() {
  const [open, setOpen] = useState(false);
  const [left, setLeft] = useState(0);
  const anchor = useRef(null), tooltip = useRef(null);
  const id = useId();

  useLayoutEffect(() => {
    if (!open) return;
    const position = () => {
      const link = anchor.current.getBoundingClientRect();
      const width = tooltip.current.getBoundingClientRect().width;
      setLeft(Math.max(16 - link.left, Math.min((link.width - width) / 2,
        window.innerWidth - 16 - link.left - width)));
    };
    position();
    window.addEventListener("resize", position);
    return () => window.removeEventListener("resize", position);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const dismiss = event => { if (!anchor.current.contains(event.target)) setOpen(false); };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [open]);

  return <span ref={anchor} className="folder-structure-help"
    style={{ display: "inline-block", position: "relative" }}
    onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
    <button type="button" aria-expanded={open} aria-controls={open ? id : undefined}
      aria-describedby={open ? id : undefined}
      style={{ padding: 0, border: 0, background: "none", color: "#14687c", font: "inherit",
        fontWeight: 600, textDecoration: "underline", cursor: "pointer" }}
      onFocus={() => setOpen(true)}
      onBlur={event => { if (!event.currentTarget.parentElement.contains(event.relatedTarget)) setOpen(false); }}
      onClick={() => setOpen(true)}
      onKeyDown={event => { if (event.key === "Escape") { setOpen(false); event.preventDefault(); } }}>
      View folder structure
    </button>
    {open && <span ref={tooltip} id={id} role="tooltip" className="folder-structure-tree"
      style={{ display: "block", position: "absolute", top: "calc(100% + 8px)", left,
        zIndex: 100, boxSizing: "border-box", width: "max-content",
        maxWidth: "min(260px, calc(100vw - 32px))", padding: "12px 16px", background: "#fff",
        border: "1px solid #ddd", borderRadius: 8, color: "#333", boxShadow: "0 4px 12px #00000026",
        textAlign: "left" }}>
      <code style={{ display: "block", overflow: "auto", whiteSpace: "pre", font: "12px/1.5 monospace" }}>{`Your Data Folder/
├── Baseline/
│   ├── Run 1/
│   ├── Run 2/
│   └── Run 3/
└── Scenario/
    ├── Run 1/
    ├── Run 2/
    └── Run 3/`}</code>
    </span>}
  </span>;
}
