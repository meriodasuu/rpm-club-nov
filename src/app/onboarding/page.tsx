import { Onboarding } from "@/components/onboarding";
export default function Page(){return <Onboarding botUrl={process.env.TELEGRAM_BOT_USERNAME?'https://t.me/'+process.env.TELEGRAM_BOT_USERNAME:undefined}/>;}
