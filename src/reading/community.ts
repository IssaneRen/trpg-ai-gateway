import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { randomInt } from "node:crypto";
import { reject } from "../auth/accounts.js";

export type Article = {id:string; title:string; account:string; reads:number|null; url:string; evidence:string|null; inlineLinks?:unknown; illustrations?:unknown; paragraphs?:string[]; license?:string};
type Input = Record<string, unknown>;
function stringField(value:unknown, max:number, label:string) {
  if(typeof value!=="string" || !value.trim() || value.length>max) reject(400,label+"格式错误");
  return value.trim();
}
function entryKey(value:unknown) {
  const key=stringField(value,80,"标识");
  if(!/^[a-zA-Z0-9_-]+$/.test(key)) reject(400,"标识格式错误");
  return key;
}
export class ReadingCommunity {
  private readonly articles:Map<string,Article>;
  constructor(private readonly db:DatabaseSync, articles:Article[]=["articles","open","weekly","linux"].flatMap(name=>JSON.parse(readFileSync(new URL("../../data/reading/"+name+".json",import.meta.url),"utf8")))) {
    this.articles=new Map(articles.map(a=>[a.id,a]));
    db.exec(`
      CREATE TABLE IF NOT EXISTS book_reviews(owner TEXT, id TEXT, book TEXT NOT NULL,title TEXT NOT NULL,body TEXT NOT NULL,updated TEXT NOT NULL,PRIMARY KEY(owner,id));
      CREATE INDEX IF NOT EXISTS reviews_by_book ON book_reviews(book,updated);
      CREATE TABLE IF NOT EXISTS article_votes(owner TEXT,article TEXT,verdict TEXT NOT NULL,created TEXT NOT NULL,PRIMARY KEY(owner,article));
      CREATE TABLE IF NOT EXISTS article_positions(owner TEXT PRIMARY KEY,article TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS article_marks(owner TEXT,article TEXT,paragraph INTEGER,start INTEGER,quote TEXT,created TEXT NOT NULL,PRIMARY KEY(owner,article,paragraph,start,quote));
    `);
    if (!db.prepare("PRAGMA table_info(article_votes)").all().some(column=>column.name==="pool")) {
      db.exec("ALTER TABLE article_votes ADD COLUMN pool TEXT");
    }
  }
  private next(owner:string, mode:string|null) {
    const pool=mode==="all" || mode==="popular" ? mode : "full";
    const position=owner+":"+pool;
    const eligible=[...this.articles.values()].filter(a=>pool==="all" || (pool==="popular" ? (a.reads??0)>=10000 : a.paragraphs?.length));
    const voted=new Set(this.db.prepare("SELECT article FROM article_votes WHERE owner=?").all(owner).map(r=>r.article));
    const saved=this.db.prepare("SELECT article FROM article_positions WHERE owner=?").get(position);
    let article=this.articles.get(String(saved?.article));
    if(!article || voted.has(article.id) || !eligible.some(a=>a.id===article?.id)) {
      const pool=eligible.filter(a=>!voted.has(a.id));
      article=pool.length?pool[randomInt(pool.length)]:undefined;
      if(article)this.db.prepare("INSERT OR REPLACE INTO article_positions VALUES(?,?)").run(position,article.id);
    }
    return {article:article??null,total:eligible.length,reviewed:eligible.filter(a=>voted.has(a.id)).length,marks:article?this.db.prepare("SELECT paragraph,start,quote FROM article_marks WHERE owner=? AND article=?").all(owner,article.id):[]};
  }
  route(path:string,method:string,params:URLSearchParams,owner:string,admin:boolean,body:Input) {
    if(path==="/next" && method==="GET")return this.next(owner,params.get("pool"));
    if(path==="/export" && method==="GET"){
      if(!admin)reject(403,"需要管理员");
      return {version:1,exportedAt:new Date().toISOString(),articles:[...this.articles.values()],votes:this.db.prepare("SELECT * FROM article_votes ORDER BY created").all(),marks:this.db.prepare("SELECT * FROM article_marks ORDER BY created").all()};
    }
    if((path==="/vote" || path==="/mark") && method==="POST"){
      const article=this.articles.get(String(body.article));
      if(!article)reject(404,"文章不存在");
      const date=new Date().toISOString();
      if(path==="/vote"){
        const verdict=String(body.verdict);
        if(!["like","dislike","ai"].includes(verdict))reject(400,"未知评价");
        const pool=params.get("pool");
        this.db.prepare("INSERT INTO article_votes(owner,article,verdict,created,pool) VALUES(?,?,?,?,?) ON CONFLICT(owner,article) DO NOTHING")
          .run(owner,article.id,verdict,date,pool==="all"||pool==="popular"?pool:"full");
        return this.next(owner,params.get("pool"));
      }
      const quote=stringField(body.quote,600,"选段"), paragraph=Number(body.paragraph),start=Number(body.start);
      if(!Number.isSafeInteger(paragraph)||paragraph< -1||!Number.isSafeInteger(start)||start<0)reject(400,"位置错误");
      if(paragraph>=0 && article.paragraphs?.[paragraph]?.slice(start,start+quote.length)!==quote)reject(400,"选区与原文不匹配");
      this.db.prepare("INSERT OR IGNORE INTO article_marks VALUES(?,?,?,?,?,?)").run(owner,article.id,paragraph,start,quote,date);
      return {ok:true};
    }
    if(path==="/reviews" && method==="GET"){
      const key=params.get("book"),before=Math.max(0,Number(params.get("offset"))||0);
      const filter=key?"WHERE r.book=?":"";
      return this.db.prepare(`SELECT r.*,a.nickname FROM book_reviews r JOIN accounts a ON r.owner=a.id AND a.deleted=0 ${filter} ORDER BY r.updated DESC,r.owner,r.id LIMIT 40 OFFSET ?`).all(...(key?[key]:[]),before);
    }
    if(path==="/reviews" && method==="PUT"){
      const id=entryKey(body.id),book=entryKey(body.book),title=stringField(body.title,300,"书名"),content=stringField(body.body,4000,"书评");
      this.db.prepare("INSERT INTO book_reviews VALUES(?,?,?,?,?,?) ON CONFLICT(owner,id) DO UPDATE SET body=excluded.body,title=excluded.title,updated=excluded.updated").run(owner,id,book,title,content,new Date().toISOString());
      return {ok:true};
    }
    if(path==="/reviews" && method==="DELETE"){
      const id=entryKey(params.get("id"));
      if(!this.db.prepare("DELETE FROM book_reviews WHERE owner=? AND id=?").run(owner,id).changes)reject(404,"书评不存在");
      return {ok:true};
    }
    reject(404,"接口不存在");
  }
}
