import {ArrowDownToLine,ArrowUpFromLine,Plus,Trash2} from 'lucide-react';
import type {ReactNode} from 'react';
import {Button,Input} from './ui';
import {Select,SelectContent,SelectItem,SelectTrigger,SelectValue} from './components/select';
import {Switch} from './components/switch';
import {Tabs,TabsContent,TabsList,TabsTrigger} from './components/tabs';

export type WsClient={name:string;enable:boolean;url:string;token?:string;messagePostFormat:'array'|'string';reportSelfMessage:boolean;debug:boolean;heartInterval:number;reconnectInterval:number;tokenConfigured?:boolean};
export type WsServer={name:string;enable:boolean;host:string;port:number;token?:string;messagePostFormat:'array'|'string';reportSelfMessage:boolean;debug:boolean;heartInterval:number;enableForcePushEvent:boolean;tokenConfigured?:boolean};

type Props={clients:WsClient[];servers:WsServer[];onClientsChange:(value:WsClient[])=>void;onServersChange:(value:WsServer[])=>void};
const tokenDescription=(configured?:boolean)=>configured?'A token is configured. Leave blank to keep it; enter a value to replace it.':'Optional. The value is write-only after saving.';

export function WebSocketConnectionEditor({clients,servers,onClientsChange,onServersChange}:Props){
  const editClient=(index:number,patch:Partial<WsClient>)=>onClientsChange(clients.map((item,current)=>current===index?{...item,...patch}:item));
  const editServer=(index:number,patch:Partial<WsServer>)=>onServersChange(servers.map((item,current)=>current===index?{...item,...patch}:item));
  const addClient=()=>onClientsChange([...clients,{name:'WebSocket client',enable:true,url:'wss://example.com/ws',messagePostFormat:'array',reportSelfMessage:false,debug:false,heartInterval:30000,reconnectInterval:5000}]);
  const addServer=()=>onServersChange([...servers,{name:'WebSocket server',enable:true,host:'0.0.0.0',port:3001,messagePostFormat:'array',reportSelfMessage:false,debug:false,heartInterval:30000,enableForcePushEvent:true}]);
  return <Tabs defaultValue="clients" className="ws-tabs">
    <div className="ws-tabs-toolbar">
      <TabsList className="product-tabs-list">
        <TabsTrigger className="product-tabs-trigger after:hidden" value="clients"><ArrowUpFromLine/>Outbound clients <span>{clients.length}</span></TabsTrigger>
        <TabsTrigger className="product-tabs-trigger after:hidden" value="servers"><ArrowDownToLine/>Inbound servers <span>{servers.length}</span></TabsTrigger>
      </TabsList>
    </div>
    <TabsContent value="clients">
      <PanelHeader title="Outbound clients" description="NapCat connects to these OneBot consumers." action="Add client" onAdd={addClient}/>
      {clients.length===0?<EmptyConnections/>:<div className="ws-connection-list">{clients.map((client,index)=><article className="ws-connection" key={`client-${index}`}>
        <ConnectionHeader icon={<ArrowUpFromLine/>} title={client.name||`Client ${index+1}`} enabled={client.enable} enabledId={`client-enabled-${index}`} onEnabled={enable=>editClient(index,{enable})} onRemove={()=>onClientsChange(clients.filter((_,current)=>current!==index))}/>
        <div className="ws-primary-grid ws-client-grid">
          <Input label="Name" aria-label="Client name" value={client.name} onChange={event=>editClient(index,{name:event.currentTarget.value})}/>
          <div className="ws-span-2"><Input label="WebSocket URL" aria-label="Client URL" value={client.url} onChange={event=>editClient(index,{url:event.currentTarget.value})}/></div>
          <div className="ws-span-full"><Input label="Access token" aria-label="Client access token" type="password" description={tokenDescription(client.tokenConfigured)} placeholder={client.tokenConfigured?'Configured':'Optional'} value={client.token??''} onChange={event=>editClient(index,{token:event.currentTarget.value||undefined})}/></div>
        </div>
        <div className="ws-advanced-grid">
          <ChoiceField label="Message format" ariaLabel="Client message format" value={client.messagePostFormat} onChange={messagePostFormat=>editClient(index,{messagePostFormat:messagePostFormat as WsClient['messagePostFormat']})}/>
          <Input label="Heartbeat (ms)" aria-label="Client heartbeat interval" type="number" min={1000} max={300000} value={client.heartInterval} onChange={event=>editClient(index,{heartInterval:Number(event.currentTarget.value)})}/>
          <Input label="Reconnect (ms)" aria-label="Client reconnect interval" type="number" min={1000} max={300000} value={client.reconnectInterval} onChange={event=>editClient(index,{reconnectInterval:Number(event.currentTarget.value)})}/>
          <SwitchField label="Report self messages" checked={client.reportSelfMessage} onChange={reportSelfMessage=>editClient(index,{reportSelfMessage})}/>
          <SwitchField label="Debug logging" checked={client.debug} onChange={debug=>editClient(index,{debug})}/>
        </div>
      </article>)}</div>}
    </TabsContent>
    <TabsContent value="servers">
      <PanelHeader title="Inbound servers" description="Consumers connect to listeners exposed by NapCat." action="Add server" onAdd={addServer}/>
      {servers.length===0?<EmptyConnections/>:<div className="ws-connection-list">{servers.map((server,index)=><article className="ws-connection" key={`server-${index}`}>
        <ConnectionHeader icon={<ArrowDownToLine/>} title={server.name||`Server ${index+1}`} enabled={server.enable} enabledId={`server-enabled-${index}`} onEnabled={enable=>editServer(index,{enable})} onRemove={()=>onServersChange(servers.filter((_,current)=>current!==index))}/>
        <div className="ws-primary-grid ws-server-grid">
          <Input label="Name" aria-label="Server name" value={server.name} onChange={event=>editServer(index,{name:event.currentTarget.value})}/>
          <Input label="Listen host" aria-label="Server host" value={server.host} onChange={event=>editServer(index,{host:event.currentTarget.value})}/>
          <Input label="Port" aria-label="Server port" type="number" min={1} max={65535} value={server.port} onChange={event=>editServer(index,{port:Number(event.currentTarget.value)})}/>
          <div className="ws-span-full"><Input label="Access token" aria-label="Server access token" type="password" description={tokenDescription(server.tokenConfigured)} placeholder={server.tokenConfigured?'Configured':'Optional'} value={server.token??''} onChange={event=>editServer(index,{token:event.currentTarget.value||undefined})}/></div>
        </div>
        <div className="ws-advanced-grid">
          <ChoiceField label="Message format" ariaLabel="Server message format" value={server.messagePostFormat} onChange={messagePostFormat=>editServer(index,{messagePostFormat:messagePostFormat as WsServer['messagePostFormat']})}/>
          <Input label="Heartbeat (ms)" aria-label="Server heartbeat interval" type="number" min={1000} max={300000} value={server.heartInterval} onChange={event=>editServer(index,{heartInterval:Number(event.currentTarget.value)})}/>
          <SwitchField label="Report self messages" checked={server.reportSelfMessage} onChange={reportSelfMessage=>editServer(index,{reportSelfMessage})}/>
          <SwitchField label="Force-push events" checked={server.enableForcePushEvent} onChange={enableForcePushEvent=>editServer(index,{enableForcePushEvent})}/>
          <SwitchField label="Debug logging" checked={server.debug} onChange={debug=>editServer(index,{debug})}/>
        </div>
      </article>)}</div>}
    </TabsContent>
  </Tabs>;
}

function PanelHeader({title,description,action,onAdd}:{title:string;description:string;action:string;onAdd:()=>void}){return <header className="ws-panel-header"><div><h3>{title}</h3><p>{description}</p></div><Button type="button" variant="outline" size="sm" onClick={onAdd}><Plus data-icon="inline-start"/>{action}</Button></header>}
function EmptyConnections(){return <div className="ws-empty">No connections configured.</div>}
function ConnectionHeader({icon,title,enabled,enabledId,onEnabled,onRemove}:{icon:ReactNode;title:string;enabled:boolean;enabledId:string;onEnabled:(value:boolean)=>void;onRemove:()=>void}){return <header className="ws-connection-header"><div className="ws-connection-title"><span className="ws-direction-icon">{icon}</span><div><strong>{title}</strong><small>{enabled?'Enabled':'Disabled'}</small></div></div><div className="ws-connection-actions"><label className="ws-enabled" htmlFor={enabledId}><Switch id={enabledId} size="sm" checked={enabled} onCheckedChange={onEnabled}/><span>Enabled</span></label><Button type="button" variant="ghost" size="icon-sm" aria-label={`Remove ${title}`} onClick={onRemove}><Trash2/></Button></div></header>}
function SwitchField({label,checked,onChange}:{label:string;checked:boolean;onChange:(value:boolean)=>void}){return <label className="ws-toggle"><Switch size="sm" checked={checked} onCheckedChange={onChange}/><span>{label}</span></label>}
function ChoiceField({label,ariaLabel,value,onChange}:{label:string;ariaLabel:string;value:string;onChange:(value:string)=>void}){return <label className="field"><span>{label}</span><Select value={value} onValueChange={onChange}><SelectTrigger aria-label={ariaLabel} className="w-full"><SelectValue/></SelectTrigger><SelectContent><SelectItem value="array">Array</SelectItem><SelectItem value="string">String</SelectItem></SelectContent></Select></label>}
