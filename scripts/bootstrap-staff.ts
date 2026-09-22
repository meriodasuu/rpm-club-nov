import {createClient} from '@supabase/supabase-js';
import {query,closePool} from '../src/lib/db';
const email=process.argv[2];
if(!email||!process.env.SUPABASE_URL||!process.env.SUPABASE_SERVICE_ROLE_KEY)throw new Error('Usage: npm run staff:bootstrap -- email; configure Supabase first');
const auth=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
async function main(){let id:string|undefined;for(let page=1;page<=100;page++){const {data,error}=await auth.auth.admin.listUsers({page,perPage:100});if(error)throw new Error('Supabase user lookup failed');id=data.users.find(u=>u.email?.toLowerCase()===email.toLowerCase())?.id;if(id||data.users.length<100)break;}if(!id)throw new Error('Create the staff account in Supabase Auth first');const existing=await query('SELECT id FROM admin_memberships LIMIT 1');if(existing.length)throw new Error('First-admin bootstrap already completed; use the team screen');await query("INSERT INTO admin_memberships(auth_user_id,email,name,role) VALUES($1,$2,$2,'admin')",[id,email]);console.log('First administrator added. Complete MFA enrollment at sign-in.');}
main().catch(e=>{console.error(e.message);process.exitCode=1;}).finally(closePool);
