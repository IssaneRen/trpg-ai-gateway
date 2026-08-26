import { describe, expect, it } from "vitest";
import { extractQqChatbotPortrait } from "./qq-chatbot-portrait.js";

describe("extractQqChatbotPortrait", () => {
  it("extracts a matching first-line portrait marker and strips it from content", () => {
    expect(
      extractQqChatbotPortrait("【立绘: 尴尬.jpg】\n我记得。", ["尴尬.jpg", "微笑.png"])
    ).toEqual({
      content: "我记得。",
      portraitFile: "尴尬.jpg"
    });
  });

  it("ignores unknown portrait file names but still strips the marker", () => {
    expect(extractQqChatbotPortrait("【立绘: 生气.jpg】\n别靠近。", ["尴尬.jpg"])).toEqual({
      content: "别靠近。"
    });
  });

  it("ignores unsafe portrait paths", () => {
    expect(extractQqChatbotPortrait("【立绘: ../secret.jpg】\n别靠近。", ["../secret.jpg"])).toEqual({
      content: "别靠近。"
    });
  });

  it("leaves content unchanged when there is no first-line portrait marker", () => {
    expect(extractQqChatbotPortrait("我记得。\n【立绘: 尴尬.jpg】", ["尴尬.jpg"])).toEqual({
      content: "我记得。\n【立绘: 尴尬.jpg】"
    });
  });
});
