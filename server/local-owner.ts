import {Core,password} from './core.js';
import {Store} from './store.js';
import {accountInput} from '../shared/contracts.js';

export function initializeLocalOwner(store:Store,username:string,secret:string){
 const parsed=accountInput.safeParse({username,password:secret,role:'admin'});
 if(!parsed.success)throw new Error('Логин: 3–50 латинских букв, цифр, _ . -; пароль: 12–200 символов.');
 if((store.db.prepare('SELECT COUNT(*) AS total FROM records').get() as {total:number}).total!==0)throw new Error('База уже содержит данные. Настройка не меняет существующие аккаунты; используйте вход администратора.');
 new Core(store).seed({username:parsed.data.username,passwordHash:password(parsed.data.password)});
}
