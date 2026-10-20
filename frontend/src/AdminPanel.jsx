import { useEffect, useState } from 'react'
import './AdminPanel.css'

export default function AdminPanel({ user, requestJson, onChange }) {
  if (user?.role !== 'admin') return null
  return <AdminWorkspace user={user} requestJson={requestJson} onChange={onChange} />
}
function AdminWorkspace({ user, requestJson, onChange }) {
  const [tab,setTab] = useState('services')
  const [data,setData] = useState(null)
  const [error,setError] = useState('')
  const [message,setMessage] = useState('')
  const [busy,setBusy] = useState(false)
  const [version,setVersion] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    requestJson('/api/admin/overview',{signal:controller.signal})
      .then((result) => { if (!controller.signal.aborted) { setData(result); setError('') } })
      .catch((err) => { if (!controller.signal.aborted) { setData(null); setError(err.message) } })
    return () => controller.abort()
  },[requestJson,version])
  async function mutate(url,method,body) {
    if (busy) return false
    setBusy(true); setError(''); setMessage('')
    try {
      const result = await requestJson(url,{method,headers:{'Content-Type':'application/json','X-QueueLess-Action':'admin'},body:JSON.stringify(body)})
      setMessage(result.message); setVersion((v) => v+1); onChange?.()
      return true
    } catch (err) { setError(err.message); return false }
    finally { setBusy(false) }
  }
  return <section id="admin" className="admin-panel" aria-labelledby="admin-heading">
    <div className="admin-heading"><div><p className="eyebrow">Campus operations</p><h2 id="admin-heading">Admin workspace</h2></div>
      <button type="button" className="admin-secondary" disabled={busy} onClick={() => setVersion((v) => v+1)}>Refresh workspace</button></div>
    <div className="admin-tabs" role="group" aria-label="Admin sections">
      {['services','counters','people','reports'].map((name) => <button key={name} type="button" disabled={busy} aria-pressed={tab===name} onClick={() => {setTab(name);setError('');setMessage('')}}>{name[0].toUpperCase()+name.slice(1)}</button>)}
    </div>
    {error && <p className="error-message" role="alert">{error}</p>}
    {message && <p className="admin-success" role="status">{message}</p>}
    {!data && !error && <p role="status">Loading administration…</p>}
    {data && <>
      {tab==='services' && <ServiceManager services={data.services} busy={busy} mutate={mutate} />}
      {tab==='counters' && <CounterManager data={data} busy={busy} mutate={mutate} />}
      {tab==='people' && <PeopleManager user={user} data={data} busy={busy} mutate={mutate} requestJson={requestJson} />}
      {tab==='reports' && <Reports data={data} requestJson={requestJson} />}
    </>}
  </section>
}
function ServiceManager({ services,busy,mutate }) {
  const [selected,setSelected] = useState('new')
  const service = services.find((item) => String(item.id)===selected)
  return <div className="admin-columns"><div>
    <label htmlFor="admin-service-choice">Service to edit</label>
    <select id="admin-service-choice" value={selected} disabled={busy} onChange={(e) => setSelected(e.target.value)}>
      <option value="new">Create a service</option>{services.map((s) => <option key={s.id} value={s.id}>{s.name} · {s.isOpen?'Open':'Closed'}</option>)}
    </select>
    <p>Closing a service stops new joins and new calls. Existing visitors can finish service.</p>
  </div><ServiceEditor key={selected} service={service} busy={busy} mutate={mutate} /></div>
}
function ServiceEditor({ service,busy,mutate }) {
  const [name,setName]=useState(service?.name||'')
  const [description,setDescription]=useState(service?.description||'')
  const [hours,setHours]=useState(service?.hours||'9:00 AM – 5:00 PM')
  const [isOpen,setOpen]=useState(service?.isOpen??true)
  return <form className="admin-form" onSubmit={async (e) => { e.preventDefault(); const ok=await mutate(service?`/api/admin/services/${service.id}`:'/api/admin/services',service?'PUT':'POST',{name,description,hours,isOpen}); if(ok&&!service){setName('');setDescription('')} }}>
    <h3>{service?'Edit service':'Create service'}</h3>
    <label htmlFor="service-name">Service name</label><input id="service-name" required maxLength={100} value={name} onChange={(e)=>setName(e.target.value)} disabled={busy}/>
    <label htmlFor="service-description">Description</label><textarea id="service-description" required maxLength={500} value={description} onChange={(e)=>setDescription(e.target.value)} disabled={busy}/>
    <label htmlFor="service-hours">Opening hours</label><input id="service-hours" required maxLength={100} value={hours} onChange={(e)=>setHours(e.target.value)} disabled={busy}/>
    <label className="admin-check"><input type="checkbox" checked={isOpen} onChange={(e)=>setOpen(e.target.checked)} disabled={busy}/>Accept visitors and allow new calls</label>
    <p>Hours are displayed as information. This switch controls whether the queue is open.</p>
    <button className="primary-button" disabled={busy}>{busy?'Saving…':'Save service'}</button>
  </form>
}
function CounterManager({ data,busy,mutate }) {
  const [selected,setSelected]=useState('new')
  const counter=data.counters.find((item)=>String(item.id)===selected)
  return <div className="admin-columns"><div><label htmlFor="admin-counter-choice">Counter to edit</label>
    <select id="admin-counter-choice" value={selected} disabled={busy} onChange={(e)=>setSelected(e.target.value)}><option value="new">Create a counter</option>{data.counters.map((c)=><option key={c.id} value={c.id}>{c.serviceName} · {c.name} · {c.active?'Enabled':'Disabled'}</option>)}</select>
    <p>Disable a counter to stop new calls. Its current visitor can still be served. Records stay in history.</p>
    <h3>Assignments</h3>{!data.assignments.length?<p>No operators assigned.</p>:<ul className="admin-assignments">{data.assignments.map((a)=><li key={`${a.counterId}:${a.operatorId}`}><span>{data.counters.find((c)=>c.id===a.counterId)?.serviceName} · {data.counters.find((c)=>c.id===a.counterId)?.name}<br/>{a.name} ({a.email})</span><button type="button" className="admin-secondary" disabled={busy} onClick={()=>mutate('/api/admin/assignments','PUT',{counterId:a.counterId,operatorId:a.operatorId,assigned:false})}>Remove</button></li>)}</ul>}
  </div><CounterEditor key={selected} counter={counter} services={data.services} busy={busy} mutate={mutate}/></div>
}
function CounterEditor({ counter,services,busy,mutate }) {
  const [name,setName]=useState(counter?.name||'')
  const [serviceId,setService]=useState(String(counter?.serviceId||services[0]?.id||''))
  const [active,setActive]=useState(counter?.active??true)
  return <form className="admin-form" onSubmit={async(e)=>{e.preventDefault();const ok=await mutate(counter?`/api/admin/counters/${counter.id}`:'/api/admin/counters',counter?'PUT':'POST',{name,serviceId:Number(serviceId),active});if(ok&&!counter)setName('')}}>
    <h3>{counter?'Edit counter':'Create counter'}</h3>
    <label htmlFor="counter-service">Service</label><select id="counter-service" value={serviceId} disabled={busy||!!counter} required onChange={(e)=>setService(e.target.value)}>{services.map((s)=><option key={s.id} value={s.id}>{s.name}</option>)}</select>
    <label htmlFor="counter-name">Counter name</label><input id="counter-name" required maxLength={100} value={name} disabled={busy} onChange={(e)=>setName(e.target.value)}/>
    <label className="admin-check"><input type="checkbox" checked={active} disabled={busy} onChange={(e)=>setActive(e.target.checked)}/>Counter enabled</label>
    <button className="primary-button" disabled={busy||!serviceId}>{busy?'Saving…':'Save counter'}</button>
  </form>
}
function PeopleManager({ user,data,busy,mutate,requestJson }) {
  const [email,setEmail]=useState('')
  const [found,setFound]=useState(null)
  const [role,setRole]=useState('visitor')
  const [counterId,setCounter]=useState('')
  const [searching,setSearching]=useState(false)
  const [note,setNote]=useState('')
  async function search(e) {
    e.preventDefault();setSearching(true);setNote('');setFound(null)
    try {const result=await requestJson(`/api/admin/users?email=${encodeURIComponent(email.trim())}`);const account=result.users[0];setFound(account||null);if(account)setRole(account.role);else setNote('No account found. Ask this person to register first.')}
    catch(err){setNote(err.message)}finally{setSearching(false)}
  }
  return <div className="admin-columns"><div><h3>Find a registered account</h3><form className="admin-form" onSubmit={search}><label htmlFor="people-email">Exact email address</label><input id="people-email" type="email" required maxLength={254} value={email} onChange={(e)=>setEmail(e.target.value)} disabled={busy||searching}/><button className="primary-button" disabled={busy||searching}>{searching?'Searching…':'Find account'}</button></form>
    <p>Accounts start as visitors. Promote staff here, then assign operators to their counters.</p>{note&&<p role="status">{note}</p>}
  </div>{found&&<div className="admin-form"><h3>{found.name}</h3><p>{found.email} · Current role: {found.role}</p>
    <form onSubmit={async(e)=>{e.preventDefault();if(await mutate(`/api/admin/users/${found.id}/role`,'PUT',{role})){setFound({...found,role})}}}>
      <label htmlFor="person-role">Account role</label><select id="person-role" value={role} disabled={busy||found.id===user.id} onChange={(e)=>setRole(e.target.value)}>{['visitor','operator','admin'].map((r)=><option key={r}>{r}</option>)}</select>
      <button className="primary-button" disabled={busy||found.id===user.id}>Save role</button>
    </form>
    {found.role==='operator'&&<form onSubmit={(e)=>{e.preventDefault();mutate('/api/admin/assignments','PUT',{operatorId:found.id,counterId:Number(counterId),assigned:true})}}>
      <label htmlFor="person-counter">Assign an enabled counter</label><select id="person-counter" required value={counterId} disabled={busy} onChange={(e)=>setCounter(e.target.value)}><option value="">Choose counter</option>{data.counters.filter((c)=>c.active).map((c)=><option key={c.id} value={c.id}>{c.serviceName} · {c.name}</option>)}</select>
      <button className="primary-button" disabled={busy||!counterId}>Assign counter</button>
    </form>}
  </div>}</div>
}
function Reports({ data,requestJson }) {
  const [date,setDate]=useState(data.today)
  const [serviceId,setService]=useState('')
  const [reports,setReports]=useState([])
  const [error,setError]=useState('')
  const [loading,setLoading]=useState(true)
  const [version,setVersion]=useState(0)
  const query=`date=${encodeURIComponent(date)}&serviceId=${encodeURIComponent(serviceId)}`
  useEffect(()=>{
    const controller=new AbortController()
    requestJson(`/api/admin/reports?${query}`,{signal:controller.signal}).then((result)=>{if(!controller.signal.aborted){setReports(result.reports);setError('')}}).catch((err)=>{if(!controller.signal.aborted){setReports([]);setError(err.message)}}).finally(()=>{if(!controller.signal.aborted)setLoading(false)})
    return()=>controller.abort()
  },[query,requestJson,version])
  const number=(n)=>n==null?'—':Number(n).toLocaleString(undefined,{maximumFractionDigits:2})
  return <div><div className="admin-report-filters">
    <label>Queue date<input type="date" min="2000-01-01" max="2100-12-31" value={date} required onChange={(e)=>{setLoading(true);setDate(e.target.value)}}/></label>
    <label>Service<select value={serviceId} onChange={(e)=>{setLoading(true);setService(e.target.value)}}><option value="">All services</option>{data.services.map((s)=><option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
    <button type="button" className="admin-secondary" onClick={()=>{setLoading(true);setVersion((v)=>v+1)}}>Refresh report</button>
    <a className="primary-button" href={`/api/admin/reports.csv?${query}`}>Download CSV</a>
  </div>{loading&&<p role="status">Loading report…</p>}{error&&<p role="alert" className="error-message">{error}</p>}
    {!loading&&!error&&<div className="admin-table-scroll" tabIndex="0" role="region" aria-label="Daily service report"><table><caption>Queue activity for {date}</caption><thead><tr>{['Service','Tokens','Waiting','In progress','Completed','Cancelled','Absent','Average wait (min)','Median wait (min)','Mean service (min)','Absent %'].map((h)=><th key={h} scope="col">{h}</th>)}</tr></thead><tbody>{reports.map((r)=><tr key={r.serviceId}><th scope="row">{r.serviceName}</th>{['tokens','waiting','inProgress','completed','cancelled','noShows','averageWait','medianWait','meanService','noShowPercent'].map((key)=><td key={key}>{number(r[key])}</td>)}</tr>)}</tbody></table></div>}
    <p>Wait runs from joining to being called. Service time runs from starting to completion. Absent percentage uses completed and absent visits. A dash means there are no samples. Reports group visits by their original queue date.</p>
  </div>
}
