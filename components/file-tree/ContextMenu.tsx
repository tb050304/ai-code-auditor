"use client";
import React, { useEffect, useRef, useState } from "react";

export interface ContextMenuItem {
  key: string;
  label: string;
  icon?: string;
  danger?: boolean;
  disabled?: boolean;
  divider?: boolean;
  onClick: () => void;
}

interface ContextMenuProps {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}

export default function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [adjustedY, setAdjustedY] = useState(y);
  const [adjustedX, setAdjustedX] = useState(x);

  useEffect(() => {
    // 防止菜单溢出屏幕
    if (!menuRef.current) return;
    const rect = menuRef.current.getBoundingClientRect();
    const viewportW = window.innerWidth;
    const viewportH = window.innerHeight;

    if (x + rect.width > viewportW) {
      setAdjustedX(Math.max(0, x - rect.width));
    }
    if (y + rect.height > viewportH) {
      setAdjustedY(Math.max(0, y - rect.height));
    }
  }, [x, y]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const handleScroll = () => onClose();

    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleKey);
    window.addEventListener("scroll", handleScroll, true);

    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKey);
      window.removeEventListener("scroll", handleScroll, true);
    };
  }, [onClose]);

  return (
    <div
      ref={menuRef}
      className="fixed z-[100] min-w-[160px] bg-slate-800 border border-slate-700 rounded-md shadow-xl py-1 text-sm text-slate-200"
      style={{ left: adjustedX, top: adjustedY }}
    >
      {items.map((item) =>
        item.divider ? (
          <div key={item.key} className="my-1 border-t border-slate-700" />
        ) : (
          <button
            key={item.key}
            disabled={item.disabled}
            onClick={() => {
              item.onClick();
              onClose();
            }}
            className={`
              w-full px-3 py-1.5 text-left flex items-center gap-2
              ${item.danger ? "text-red-400 hover:bg-red-500/10" : "hover:bg-slate-700/50"}
              ${item.disabled ? "opacity-40 cursor-not-allowed" : "cursor-pointer"}
            `}
          >
            {item.icon && <span className="w-4 text-center">{item.icon}</span>}
            <span>{item.label}</span>
          </button>
        ),
      )}
    </div>
  );
}
