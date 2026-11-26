import {describe,it,expect} from "vitest";
import {DatabaseSync} from "node:sqlite";
import {ReadingCommunity} from "./community.js";
describe("共读和评测",()=>{
 it("跨账号共享书评，独立保存评价和选区，只允许作者删除",()=>{
  const db=new DatabaseSync(":memory:");
  db.exec("CREATE TABLE accounts(id TEXT,nickname TEXT,deleted INTEGER); INSERT INTO accounts VALUES('a','甲',0),('b','乙',0)");
  const lib=new ReadingCommunity(db,[{id:"w1",title:"题名",url:"https://example.org",account:"来源",reads:8,evidence:"https://example.org",paragraphs:["第一段原文"]}]);
  const call=(path:string,method="GET",owner="a",data={},params="",admin=false)=>lib.route(path,method,new URLSearchParams(params),owner,admin,data);
  call("/reviews","PUT","a",{id:"review",book:"work",title:"书名",body:"书评"});expect(call("/reviews","GET","b")).toMatchObject([{nickname:"甲",body:"书评"}]);
  expect(()=>call("/reviews","DELETE","b",{},"id=review")).toThrow();expect(call("/next")).toMatchObject({article:{id:"w1"}});
  call("/mark","POST","a",{article:"w1",quote:"一段",start:1,paragraph:0});
  expect(()=>call("/mark","POST","a",{article:"w1",quote:"错误",start:0,paragraph:0})).toThrow();
  expect(call("/vote","POST","a",{article:"w1",verdict:"ai"})).toMatchObject({article:null,reviewed:1});
  expect(call("/vote","POST","a",{article:"w1",verdict:"ai"})).toMatchObject({reviewed:1});
  expect(call("/next","GET","b")).toMatchObject({reviewed:0,marks:[]});
  expect(()=>call("/export")).toThrow();expect(call("/export","GET","a",{},"",true)).toMatchObject({marks:[{quote:"一段"}],votes:[{owner:"a",verdict:"ai"}]});
  call("/reviews","DELETE","a",{},"id=review");expect(call("/reviews")).toEqual([]);db.close();
 });
});
