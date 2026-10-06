'use client';

import { useEffect } from 'react';

export default function OAuthCallbackPage(){
  useEffect(()=>{
    const params=new URLSearchParams(window.location.search);
    const payload={
      provider:params.get('provider')||'',
      code:params.get('code')||'',
      state:params.get('state')||'',
      error:params.get('error')||'',
      error_description:params.get('error_description')||'',
    };
    if(window.opener&&!window.opener.closed){
      window.opener.postMessage({type:'smm-oauth-callback',payload},window.location.origin);
      window.close();
    }
  },[]);
  return <main style={{minHeight:'100vh',display:'grid',placeItems:'center',fontFamily:'system-ui'}}>Авторизация завершена. Это окно можно закрыть.</main>;
}
