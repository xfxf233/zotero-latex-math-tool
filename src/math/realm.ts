/**
 * Zotero 跨 realm 数据克隆的薄封装。
 *
 * 标注对象要在阅读器 iframe 的 realm 里创建，直接传主进程对象会被拒；失败时退回原值
 * 由调用方兜底。
 */
import { logError } from "./log";
import type { AnnotationManager } from "./types";

export function cloneIntoManagerRealm<T>(
  manager: AnnotationManager,
  value: T,
): T {
  return cloneValueIntoRealm(value, manager._annotations);
}

export function cloneValueIntoRealm<T>(
  value: T,
  target: object | undefined,
): T {
  if (!target) {
    return value;
  }

  try {
    return Components.utils.cloneInto(value, target, {
      cloneFunctions: false,
    }) as T;
  } catch (error) {
    logError("Unable to clone value into target realm", error);
    return value;
  }
}
