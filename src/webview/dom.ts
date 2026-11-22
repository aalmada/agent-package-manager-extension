export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function setRoleLabel(node: HTMLElement, role: string, label: string): void {
  node.setAttribute('role', role);
  node.setAttribute('aria-label', label);
}

export function countHeading(tag: 'h2' | 'h3', title: string, count: number, countClass: string, className = ''): HTMLHeadingElement {
  const heading = el(tag, className);
  heading.append(el('span', '', title), el('span', countClass, String(count)));
  return heading;
}
