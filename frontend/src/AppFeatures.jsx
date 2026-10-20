import { useEffect, useState } from 'react'
import './AppFeatures.css'

export default function AppFeatures() {
  const [online,setOnline]=useState(navigator.onLine)
  const [prompt,setPrompt]=useState(null)
  const [installed,setInstalled]=useState(()=>window.matchMedia('(display-mode: standalone)').matches||navigator.standalone===true)
  const [note,setNote]=useState('')
  useEffect(()=>{
    const goOnline=()=>setOnline(true)
    const goOffline=()=>setOnline(false)
    const install=(event)=>{event.preventDefault();setPrompt(event)}
    const done=()=>{setInstalled(true);setPrompt(null)}
    window.addEventListener('online',goOnline);window.addEventListener('offline',goOffline)
    window.addEventListener('beforeinstallprompt',install);window.addEventListener('appinstalled',done)
    return()=>{window.removeEventListener('online',goOnline);window.removeEventListener('offline',goOffline);window.removeEventListener('beforeinstallprompt',install);window.removeEventListener('appinstalled',done)}
  },[])
  async function install() {
    if(!prompt)return
    try{await prompt.prompt();const result=await prompt.userChoice;setNote(result.outcome==='accepted'?'Installation requested. Follow your browser’s instructions.':'You can install later from the browser menu.')}
    catch{setNote('Use your browser’s installation menu.')}
    finally{setPrompt(null)}
  }
  return <>
    {!online&&<div className="offline-banner" role="alert">You’re offline. Reconnect to refresh your queue or make changes.</div>}
    <section id="install" className="app-install">
      <div><p className="eyebrow">QueueLess on your phone</p><h2>{installed?'Your campus app is ready':'Take your place from anywhere'}</h2>
        <p>{installed?'Launch QueueLess from your home screen. An internet connection keeps your place up to date.':'Add QueueLess to your home screen on iPhone or Android and open it like an app.'}</p></div>
      {!installed&&<div>{prompt&&<button type="button" className="primary-button" onClick={install}>Install QueueLess</button>}
        <details><summary>How to install on your phone</summary><p><strong>iPhone:</strong> Open the secure QueueLess link in Safari. Tap Share, then Add to Home Screen and confirm.</p><p><strong>Android:</strong> Open the secure link in Chrome. Choose Install app or Add to Home screen from the browser menu.</p><p>Phone installation needs the deployed HTTPS link. The app requires an internet connection for queue changes.</p></details>
      </div>}
      {note&&<p role="status">{note}</p>}
    </section>
  </>
}
