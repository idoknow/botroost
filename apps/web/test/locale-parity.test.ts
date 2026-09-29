import {describe,expect,it} from 'vitest';
import {en,ja,zhCN,zhTW} from '../src/locales';

const locales={en,ja,zhCN,zhTW} as const;
const requiredRegistrationKeys=['login.register','login.name','login.registerFailed','login.registrationUnavailable'] as const;

describe('locale message parity',()=>{
  it('keeps every locale on the same message-key set as English',()=>{
    const expected=Object.keys(en).sort();
    for(const [locale,messages] of Object.entries(locales)){
      expect(Object.keys(messages).sort(),`${locale} message keys`).toEqual(expected);
    }
  });

  it('populates all required registration messages in every locale',()=>{
    for(const [locale,messages] of Object.entries(locales)){
      for(const key of requiredRegistrationKeys){
        expect(messages[key],`${locale}.${key}`).toEqual(expect.any(String));
        expect(messages[key].trim(),`${locale}.${key} must not be blank`).not.toBe('');
      }
    }
  });
});
