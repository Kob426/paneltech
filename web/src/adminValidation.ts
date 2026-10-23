// Immediate form feedback; the API remains authoritative for every mutation.
export function validateName(name:string){
 if(!name.trim())throw new Error('Введите название.');
 if(name.trim().length>100)throw new Error('Название должно содержать не больше 100 символов.');
 return name.trim();
}
export function parseExes(text:string){
 const values=text.split('\n').map(s=>s.trim()).filter(Boolean);
 if(values.length>30)throw new Error('Допустимо не больше 30 exe.');
 for(const value of values)if(!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}\.exe$/i.test(value))throw new Error('Укажите имена .exe без путей, команд и аргументов.');
 if(new Set(values.map(s=>s.toLowerCase())).size!==values.length)throw new Error('Имена exe не должны повторяться, в том числе с другим регистром.');
 return values;
}
export function parseVariants(text:string){
 const lines=text.split('\n').filter(s=>s.trim());
 if(!lines.length||lines.length>64)throw new Error('Укажите от 1 до 64 вариантов клуба.');
 const values=lines.map((line,index)=>{
  const match=/^\s*(\d{1,2})\s*:(.+)$/.exec(line);
  if(!match)throw new Error(`Строка ${index+1}: используйте формат ID:название, например 36:Основной.`);
  const id=Number(match[1]),name=match[2].trim();
  if(id>63)throw new Error(`Строка ${index+1}: ID должен быть целым числом от 0 до 63.`);
  if(!name||name.length>100)throw new Error(`Строка ${index+1}: название варианта должно содержать от 1 до 100 символов.`);
  return {id,name};
 });
 if(new Set(values.map(v=>v.id)).size!==values.length)throw new Error('ID вариантов клуба не должны повторяться.');
 return values;
}
export function validateUser(username:string,password:string){
 if(!/^[a-zA-Z0-9_.-]{3,50}$/.test(username))throw new Error('Логин: от 3 до 50 латинских букв, цифр или символов _ . -');
 if(password.length<12||password.length>200)throw new Error('Пароль должен содержать от 12 до 200 символов.');
}
