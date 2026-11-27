import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { ModuleDiary } from "./diary.js";

it("保留旧跑团记录，可独立修改和删除同一模组的带团记录",()=>{
  const db=new DatabaseSync(":memory:");
  db.exec("CREATE TABLE accounts(id TEXT,nickname TEXT,deleted INTEGER); INSERT INTO accounts VALUES('a','甲',0)");
  db.exec("CREATE TABLE module_diary(owner TEXT,module TEXT,rating INTEGER,review TEXT,updated TEXT, PRIMARY KEY(owner,module)); INSERT INTO module_diary VALUES('a','m',4,'旧短评','2026-01-01')");
  const diary=new ModuleDiary(db);
  diary.record("a","m",{rating:5,review:"主持笔记"},"host");
  expect(diary.records()).toMatchObject([{role:"player",review:"旧短评"}]);
  expect(diary.records(true)).toHaveLength(2);
  diary.remove("a","m","host");
  expect(diary.records(true)).toMatchObject([{role:"player",rating:4}]);
  db.close();
});
