interface Window {
  Telegram?:{WebApp:{initData:string;platform:string;ready():void;expand():void;requestContact(callback:(accepted:boolean)=>void):void;requestWriteAccess?(callback:(accepted:boolean)=>void):void;openLink(url:string):void;openTelegramLink(url:string):void;HapticFeedback?:{impactOccurred(style:string):void};BackButton:{show():void;hide():void;onClick(callback:()=>void):void;offClick(callback:()=>void):void};onEvent(name:string,callback:()=>void):void;offEvent(name:string,callback:()=>void):void;}};
}
