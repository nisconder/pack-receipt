(function () {
  "use strict";
  function node(tag, className) {
    const element = document.createElement(tag);
    element.className = className;
    return element;
  }
  // The identity is populated from the completed analysis, never by DOM filters.
  const identity = node("div", "receipt-identity");
  const reference = node("div", "receipt-reference");
  const barcode = node("span", "barcode");
  barcode.setAttribute("aria-hidden", "true");
  const details = node("div", "receipt-reference-text");
  details.append(node("span", "receipt-serial"), node("time", "receipt-time"));
  reference.append(barcode, details);
  const stamp = node("div", "receipt-stamp");
  stamp.dataset.state = "clear";
  const caption = node("span", "stamp-caption");
  caption.textContent = "包内规则检查";
  stamp.append(node("strong", "stamp-title"), caption);
  stamp.title = "本次静态规则检查结果，不是发布授权或安全证明。";
  identity.append(reference, stamp);
  document.querySelector(".receipt-header").append(identity);

  const chart = document.getElementById("treemap");
  const tooltip = node("div", "map-tooltip");
  tooltip.id = "map-tooltip";
  tooltip.hidden = true;
  tooltip.setAttribute("role", "tooltip");
  document.body.append(tooltip);
  let activeBlock = null;
  function hideTooltip() {
    tooltip.hidden = true;
    if (activeBlock) activeBlock.removeAttribute("aria-describedby");
    activeBlock = null;
  }
  function showTooltip(event) {
    const block = event.target.closest?.("#treemap g[role='button']");
    if (!block) { hideTooltip(); return; }
    if (activeBlock && activeBlock !== block) activeBlock.removeAttribute("aria-describedby");
    activeBlock = block;
    activeBlock.setAttribute("aria-describedby", tooltip.id);
    tooltip.textContent = block.getAttribute("aria-label");
    tooltip.hidden = false;
    const bounds = block.getBoundingClientRect();
    const x = event.type === "focusin" ? bounds.left + bounds.width / 2 : event.clientX;
    const y = event.type === "focusin" ? bounds.bottom : event.clientY;
    const tip = tooltip.getBoundingClientRect();
    tooltip.style.left = `${Math.max(12, Math.min(x + 12, innerWidth - tip.width - 12))}px`;
    tooltip.style.top = `${Math.max(12, Math.min(y + 14, innerHeight - tip.height - 12))}px`;
  }
  chart.addEventListener("pointermove", showTooltip);
  chart.addEventListener("pointerleave", hideTooltip);
  chart.addEventListener("focusin", showTooltip);
  chart.addEventListener("focusout", hideTooltip);
  chart.addEventListener("click", hideTooltip);
  window.addEventListener("scroll", hideTooltip, { passive: true });
  window.addEventListener("blur", hideTooltip);
  window.addEventListener("pack:analysis-start", hideTooltip);
  window.addEventListener("pack:analysis-reset", hideTooltip);
})();
