import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseVariants,parseExes,validateName,validateUser} from '../web/src/adminValidation.js';
import {clubInput,gameInput} from '../shared/contracts.js';

test('club text rejects ambiguous ID syntax and duplicate/range errors before serialization',()=>{
 for(const text of ['36','36 Основной',':Основной','-1:Нет','3.6:Нет','64:Нет','36:   ','36:A\n036:B','36:A\n36:B',''])assert.throws(()=>parseVariants(text),Error,text);
 const variants=parseVariants('0:Без маркировки\n 63 : Приоритет: высокий ');
 assert.deepEqual(variants,[{id:0,name:'Без маркировки'},{id:63,name:'Приоритет: высокий'}]);
 assert.equal(clubInput.safeParse({name:'Клуб',variants}).success,true);
});
test('game form rejects injection, paths, duplicate exe and oversized sets but permits an empty draft card',()=>{
 for(const text of ['C:\\game.exe','game.exe -x','game.exe\nGAME.exe',Array.from({length:31},(_,i)=>`game${i}.exe`).join('\n')])assert.throws(()=>parseExes(text));
 assert.deepEqual(parseExes(' \n '),[]);
 assert.equal(gameInput.safeParse({name:validateName(' Игра '),exes:parseExes('game.exe\nhelper.exe')}).success,true);
});
test('form titles reject whitespace and enforce the API trimmed title limit',()=>{
 assert.throws(()=>validateName('   '));assert.throws(()=>validateName('a'.repeat(101)));
 assert.equal(validateName(' a '),'a');
});
test('new employee validation rejects unsafe login syntax and password boundary violations',()=>{
 for(const name of ['ab','сотрудник','user name','a'.repeat(51)])assert.throws(()=>validateUser(name,'a'.repeat(12)));
 for(const password of ['a'.repeat(11),'a'.repeat(201)])assert.throws(()=>validateUser('staff',password));
 validateUser('staff_1.test','a'.repeat(12));
});
