/**
 * DOM 小工具：只在值确实变化时写 style/class/dataset，减少无意义布局与 observer 触发。
 */

export function setStyleIfChanged(
  element: HTMLElement,
  property: string,
  value: string,
): void {
  if (element.style.getPropertyValue(property) !== value) {
    element.style.setProperty(property, value);
  }
}

export function toggleClassIfChanged(
  element: HTMLElement,
  className: string,
  enabled: boolean,
): void {
  if (element.classList.contains(className) !== enabled) {
    element.classList.toggle(className, enabled);
  }
}

export function setDatasetIfChanged(
  element: HTMLElement,
  key: string,
  value: string,
): void {
  if (element.dataset[key] !== value) {
    element.dataset[key] = value;
  }
}

export function getSourceText(element: HTMLElement): string {
  const ownValue = getTextFieldValue(element);
  if (ownValue) {
    return ownValue.trim();
  }

  const field = [...element.querySelectorAll<HTMLElement>("textarea,input")]
    .map((candidate) => getTextFieldValue(candidate))
    .find((value) => value?.trim());
  if (field) {
    return field.trim();
  }

  return (element.textContent ?? "").trim();
}

export function getTextFieldValue(element: Element): string | undefined {
  const tagName = element.localName.toLowerCase();
  if (tagName !== "textarea" && tagName !== "input") {
    return undefined;
  }

  return (element as HTMLInputElement | HTMLTextAreaElement).value;
}
