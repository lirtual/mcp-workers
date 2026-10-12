import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { ImaKnowledge, ImaNotes } from "./ima.ts";
import { ImaApiError } from "./types.ts";

const ok=(data:unknown)=>({content:[{type:"text" as const,text:JSON.stringify(data,null,2)}],structuredContent:data});
const fail=(e:unknown)=>({
  content:[{type:"text" as const,text:e instanceof Error?e.message:String(e)}],
  structuredContent:e instanceof ImaApiError?{code:e.code,message:e.message,details:e.details}:{error:String(e)},
  isError:true
});

export function registerTools(server:McpServer, notes:ImaNotes, kb:ImaKnowledge, allowWrite:boolean){
  server.registerTool("search_notes",{
    description:"Search IMA notes by title or body. search_type: 0=DOC_TITLE (default), 1=DOC_CONTENT. sort_type: 0=modify_time, 1=create_time, 2=title, 3=size. Paginate with start/end (max 20 per page).",
    annotations:{readOnlyHint:true},
    inputSchema:z.object({
      query:z.string().min(1).describe("Search keyword"),
      search_type:z.union([z.literal(0),z.literal(1)]).optional().describe("0: title search (default), 1: content search"),
      sort_type:z.number().int().min(0).max(3).optional().describe("0: modify_time, 1: create_time, 2: title, 3: size"),
      start:z.number().int().min(0).optional().describe("Pagination start index (0-based)"),
      end:z.number().int().min(1).optional().describe("Pagination end index (end - start <= 20)")
    })
  },async a=>{try{return ok(await notes.search(a))}catch(e){return fail(e)}});

  server.registerTool("list_notes",{description:"List IMA notes. Use cursor for pagination until is_end is true.",annotations:{readOnlyHint:true},inputSchema:z.object({folder_id:z.string().optional(),cursor:z.string().optional(),limit:z.number().int().min(1).max(20).optional()})},async a=>{try{return ok(await notes.list(a))}catch(e){return fail(e)}});
  server.registerTool("list_notebooks",{description:"List IMA notebooks. Use cursor ('0' initially) for pagination.",annotations:{readOnlyHint:true},inputSchema:z.object({cursor:z.string().optional(),limit:z.number().int().min(1).max(20).optional()})},async a=>{try{return ok(await notes.notebooks(a))}catch(e){return fail(e)}});
  server.registerTool("get_note",{description:"Read one IMA note by note_id. target_content_format: 0=plaintext without image links, 1=Markdown with image URLs (default), 2=JSON document blocks. Markdown and JSON are larger than plaintext.",annotations:{readOnlyHint:true},inputSchema:z.object({note_id:z.string().min(1),target_content_format:z.union([z.literal(0),z.literal(1),z.literal(2)]).optional().describe("0: plaintext, 1: Markdown with images (default), 2: JSON blocks")})},async a=>{try{return ok(await notes.get(a.note_id,a.target_content_format))}catch(e){return fail(e)}});

  server.registerTool("search_knowledge_bases",{description:"Search IMA knowledge bases by name or keyword.",annotations:{readOnlyHint:true},inputSchema:z.object({query:z.string().min(1),cursor:z.string().optional(),limit:z.number().int().min(1).max(20).optional()})},async a=>{try{return ok(await kb.searchBases(a.query,a.cursor,a.limit))}catch(e){return fail(e)}});
  server.registerTool("list_addable_knowledge_bases",{description:"List IMA knowledge bases that can receive content.",annotations:{readOnlyHint:true},inputSchema:z.object({cursor:z.string().optional(),limit:z.number().int().min(1).max(50).optional()})},async a=>{try{return ok(await kb.addable(a.cursor,a.limit))}catch(e){return fail(e)}});
  server.registerTool("get_knowledge_base",{description:"Get knowledge base details by IDs.",annotations:{readOnlyHint:true},inputSchema:z.object({ids:z.array(z.string()).min(1).max(20)})},async a=>{try{return ok(await kb.getBases(a.ids))}catch(e){return fail(e)}});
  server.registerTool("list_knowledge",{description:"Browse entries in an IMA knowledge base.",annotations:{readOnlyHint:true},inputSchema:z.object({knowledge_base_id:z.string(),folder_id:z.string().optional(),cursor:z.string().optional(),limit:z.number().int().min(1).max(50).optional()})},async a=>{try{return ok(await kb.list(a.knowledge_base_id,a.cursor,a.limit,a.folder_id))}catch(e){return fail(e)}});
  server.registerTool("search_knowledge",{description:"Search inside an IMA knowledge base.",annotations:{readOnlyHint:true},inputSchema:z.object({knowledge_base_id:z.string(),query:z.string().min(1),cursor:z.string().optional()})},async a=>{try{return ok(await kb.search(a.knowledge_base_id,a.query,a.cursor))}catch(e){return fail(e)}});
  server.registerTool("read_knowledge_source",{
    description:"Read an IMA knowledge item. Notes return directly (same target_content_format as get_note; default Markdown). URL text returns bounded chunks. Binary files return a direct download_url when R2 storage is configured, or bounded chunks otherwise.",
    annotations:{readOnlyHint:true},
    inputSchema:z.object({
      media_id:z.string(),
      offset:z.number().int().min(0).optional(),
      max_bytes:z.number().int().min(1).max(2*1024*1024).optional(),
      target_content_format:z.union([z.literal(0),z.literal(1),z.literal(2)]).optional().describe("Notes only. 0: plaintext, 1: Markdown with images (default), 2: JSON blocks"),
      export_to_r2:z.boolean().optional().describe("If true, exports file to R2 storage and returns download_url")
    })
  },async a=>{try{return ok(await kb.readSource(a.media_id,notes,{offset:a.offset,max_bytes:a.max_bytes,target_content_format:a.target_content_format,export_to_r2:a.export_to_r2}))}catch(e){return fail(e)}});

  server.registerTool("export_file",{
    description:"Export an IMA knowledge item (media_id) or note (note_id) to R2 storage and return a direct download URL. Provide exactly one of media_id or note_id.",
    annotations:{readOnlyHint:true},
    inputSchema:z.object({
      media_id:z.string().optional().describe("IMA knowledge base media ID to export"),
      note_id:z.string().optional().describe("IMA note ID to export"),
      file_name:z.string().optional().describe("Optional custom filename for the exported file")
    }).refine(a=>Boolean(a.media_id)!==Boolean(a.note_id),{
      message:"Provide exactly one of media_id or note_id"
    })
  },async a=>{
    try{
      if(a.media_id){
        return ok(await kb.exportSource(a.media_id,notes,{file_name:a.file_name}));
      }
      if(a.note_id){
        return ok(await notes.exportNote(a.note_id,{file_name:a.file_name}));
      }
      throw new Error("Must provide either media_id or note_id");
    }catch(e){return fail(e)}
  });

  if(allowWrite){
    server.registerTool("create_note",{description:"Create a new IMA note from Markdown. Use only when user explicitly intends to create a new note.",annotations:{readOnlyHint:false,destructiveHint:false},inputSchema:z.object({content:z.string().min(1),folder_id:z.string().optional(),folder_name:z.string().optional()})},async a=>{try{return ok(await notes.create(a))}catch(e){return fail(e)}});
    server.registerTool("append_note",{description:"Append Markdown to an existing IMA note. Ensure note_id is uniquely resolved first.",annotations:{readOnlyHint:false,destructiveHint:false},inputSchema:z.object({note_id:z.string(),content:z.string().min(1)})},async a=>{try{return ok(await notes.append(a.note_id,a.content))}catch(e){return fail(e)}});
    server.registerTool("add_urls_to_knowledge_base",{description:"Import 1-10 web URLs into an IMA knowledge base. Supports web pages and WeChat articles. File URLs must use upload_file_to_knowledge_base.",annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:true},inputSchema:z.object({knowledge_base_id:z.string(),folder_id:z.string().optional(),urls:z.array(z.url()).min(1).max(10)})},async a=>{try{return ok(await kb.importUrls(a.knowledge_base_id,a.urls,a.folder_id))}catch(e){return fail(e)}});
    server.registerTool("add_note_to_knowledge_base",{description:"Associate an existing IMA note with a knowledge base.",annotations:{readOnlyHint:false,destructiveHint:false},inputSchema:z.object({knowledge_base_id:z.string(),note_id:z.string(),title:z.string().min(1),folder_id:z.string().optional()})},async a=>{try{return ok(await kb.addNote(a.knowledge_base_id,a.note_id,a.title,a.folder_id))}catch(e){return fail(e)}});
    server.registerTool("upload_file_to_knowledge_base",{
      description:"Upload single file or batch of 1-10 files to IMA knowledge base. Downloads from publicly reachable HTTPS URLs, performs preflight type/size checks, uploads to COS, and registers in the knowledge base. Set keep_both=true to auto-rename duplicates.",
      annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:true},
      inputSchema:z.object({
        knowledge_base_id:z.string().describe("Target knowledge base ID"),
        folder_id:z.string().optional().describe("Target folder ID within the knowledge base"),
        file_url:z.url().optional().describe("Single file upload: HTTPS URL to download"),
        file_name:z.string().min(1).optional().describe("Single file upload: filename"),
        content_type:z.string().optional().describe("Single file upload: optional MIME type override"),
        keep_both:z.boolean().optional().describe("Single file upload: set true to auto-rename if duplicate exists"),
        files:z.array(z.object({
          file_url:z.url(),
          file_name:z.string().min(1).optional(),
          content_type:z.string().optional(),
          keep_both:z.boolean().optional(),
        })).min(1).max(10).optional().describe("Batch upload: array of 1-10 files to upload")
      }).refine(a=>Boolean(a.file_url)!==Boolean(a.files?.length),{
        message:"Provide exactly one of file_url or files",
      })
    },async a=>{
      try{
        if(a.files&&a.files.length>0){
          return ok(await kb.uploadBatch(a.knowledge_base_id,a.files,a.folder_id));
        }
        if(a.file_url){
          return ok(await kb.upload({
            knowledge_base_id:a.knowledge_base_id,
            file_url:a.file_url,
            file_name:a.file_name,
            folder_id:a.folder_id,
            content_type:a.content_type,
            keep_both:a.keep_both,
          }));
        }
        throw new Error("Must provide either file_url for single upload, or files array for batch upload");
      }catch(e){return fail(e)}
    });
  }
}
