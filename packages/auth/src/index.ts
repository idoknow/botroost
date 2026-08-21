import argon2 from "argon2";
import { randomBytes } from "node:crypto";
import { DatabaseError, digest, type PostgresDatabase, type Role } from "@botroost/database";
export type Permission="read"|"operate"|"manage-members"|"manage-nodes"|"bootstrap-owner";
const grants:Record<Role,Permission[]>={viewer:["read"],operator:["read","operate"],admin:["read","operate","manage-members","manage-nodes"],owner:["read","operate","manage-members","manage-nodes","bootstrap-owner"]};
export const can=(r:Role,p:Permission)=>grants[r].includes(p);
export function requireSameOriginAndCsrf(r:{method:string;origin?:string;host:string;csrfCookie?:string;csrfHeader?:string;expectedCsrfHash?:string}){if(["GET","HEAD","OPTIONS"].includes(r.method))return true;if(!r.origin||new URL(r.origin).host!==r.host||!r.csrfCookie||r.csrfCookie!==r.csrfHeader||r.expectedCsrfHash!==digest(r.csrfCookie))throw new Error("csrf rejected");return true}
export class AuthService {
 constructor(private db:PostgresDatabase,private ttlSeconds=86400){}
 async bootstrapOwner(email:string,password:string,workspaceName:string){if(password.length<12)throw new Error("password too short");return this.db.bootstrapOwner({email,passwordHash:await argon2.hash(password,{type:argon2.argon2id}),workspaceName})}
 async addMember(workspaceId:string,email:string,password:string,role:Exclude<Role,"owner">,actorUserId?:string){if(password.length<12)throw new Error("password too short");return this.db.addMember(workspaceId,{email,passwordHash:await argon2.hash(password,{type:argon2.argon2id}),role,...(actorUserId?{actorUserId}:{})})}
 async changePassword(input:{userId:string;sessionId:string;workspaceId:string;currentPassword:string;newPassword:string}){if(input.newPassword.length<12)throw new Error("password too short");const user=await this.db.findUserById(input.userId);if(!user||!await argon2.verify(user.password_hash,input.currentPassword))throw new DatabaseError("forbidden","current password is incorrect");if(await argon2.verify(user.password_hash,input.newPassword))throw new DatabaseError("conflict","new password must be different");const passwordHash=await argon2.hash(input.newPassword,{type:argon2.argon2id});await this.db.changePassword(input.userId,input.sessionId,input.workspaceId,user.password_hash,passwordHash)}
 async login(email:string,password:string){const user=await this.db.findUserByEmail(email);if(!user||!await argon2.verify(user.password_hash,password))throw new Error("invalid credentials");const token=randomBytes(32).toString("base64url"),csrf=randomBytes(24).toString("base64url");const expiresAt=new Date(Date.now()+this.ttlSeconds*1000);await this.db.createSession(user.id,digest(token),digest(csrf),expiresAt);return{token,csrf,expiresAt,cookie:`botroost_session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${this.ttlSeconds}`}}
 me(token:string){return this.db.principalForToken(digest(token))}
 logout(token:string){return this.db.revokeSession(digest(token))}
}
