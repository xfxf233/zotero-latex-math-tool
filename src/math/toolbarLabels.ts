/**
 * 从按钮标签识别 Zotero 原生工具按钮。
 *
 * Σ 按钮要插到原生"添加文字"按钮之后；dev 诊断也用它核对真机工具栏结构。
 */

export function getButtonLabel(element: HTMLElement): string {
  return [
    element.getAttribute("aria-label"),
    element.getAttribute("title"),
    element.getAttribute("data-l10n-id"),
    element.textContent,
  ]
    .filter(Boolean)
    .join(" ")
    .trim();
}

export function isFreeTextToolLabel(label: string): boolean {
  return (
    /free text|add text|text annotation|^text$|\u65b0\u589e\u6587\u5b57|\u6dfb\u52a0\u6587\u5b57|\u6dfb\u52a0\u6587\u672c/i.test(
      label,
    ) && !/highlight|underline|\u9ad8\u4eae|\u4e0b\u5212\u7ebf/i.test(label)
  );
}

export function findLastAnnotationToolButton(
  nativeButtons: HTMLElement[],
): HTMLElement | undefined {
  return nativeButtons
    .filter((candidate) => {
      const label = getButtonLabel(candidate);
      return (
        /highlight|underline|note|annotation|\u9ad8\u4eae|\u4e0b\u5212\u7ebf|\u6ce8\u91ca|\u7b14\u8bb0/i.test(
          label,
        ) &&
        !/page|zoom|sidebar|split|\u9875|\u7f29\u653e|\u4fa7\u8fb9\u680f|\u5206\u680f/i.test(
          label,
        )
      );
    })
    .at(-1);
}
